using System.Text.Json.Nodes;

namespace CommandStateKernel;

public sealed class CommandStateKernel<TState>
{
    private const string Mask = "[MASKED]";

    private sealed record MountEntry(IReadOnlyList<string> Segments, MountDescriptor<TState> Mount);

    private readonly object _gate = new();
    private readonly ReadPolicy _readPolicy;
    private readonly Action<Exception> _onListenerError;
    private readonly Scheduler? _scheduler;

    private readonly Dictionary<string, CommandDescriptor<TState>> _commands = new(StringComparer.Ordinal);
    private readonly List<MountEntry> _mounts = [];
    private readonly List<Action<TransitionRecord>> _transitionListeners = [];
    private readonly List<Action<TState>> _stateListeners = [];

    private readonly object _queueGate = new();
    private readonly Queue<Action> _deliveries = new();
    private bool _draining;

    private TState _state;

    public CommandStateKernel(TState initialState, KernelOptions? options = null)
    {
        options ??= new KernelOptions();
        _state = initialState;
        _readPolicy = options.ReadPolicy ?? ((_, _) => ReadDecision.Deny);
        _onListenerError = options.OnListenerError ?? (error => Console.Error.WriteLine(error));
        _scheduler = options.Scheduler;
    }

    public CommandStateKernel<TState> RegisterCommand(CommandDescriptor<TState> descriptor)
    {
        var parsed = KernelUri.Parse(descriptor.Uri, "command");
        if (parsed.Ref is null) throw new ArgumentException(parsed.Reason, nameof(descriptor));
        if (parsed.Ref.Uri != descriptor.Uri)
        {
            throw new ArgumentException($"Command URI must be canonical: {descriptor.Uri}", nameof(descriptor));
        }
        lock (_gate)
        {
            if (_commands.ContainsKey(parsed.Ref.Uri))
            {
                throw new InvalidOperationException($"Command already registered: {parsed.Ref.Uri}");
            }
            _commands[parsed.Ref.Uri] = descriptor;
        }
        return this;
    }

    public CommandStateKernel<TState> RegisterMount(MountDescriptor<TState> mount)
    {
        var parsed = KernelUri.Parse(mount.Uri, "state", "/", templates: true);
        if (parsed.Ref is null) throw new ArgumentException(parsed.Reason, nameof(mount));
        if (parsed.Ref.Uri != mount.Uri)
        {
            throw new ArgumentException($"Mount URI must be canonical: {mount.Uri}", nameof(mount));
        }
        lock (_gate)
        {
            if (_mounts.Any(entry => entry.Mount.Uri == parsed.Ref.Uri))
            {
                throw new InvalidOperationException($"State mount already registered: {parsed.Ref.Uri}");
            }
            _mounts.Add(new MountEntry(parsed.Ref.Segments, mount));
        }
        return this;
    }

    /// <summary>The current state. Synchronous, and never waits.</summary>
    public TState GetState()
    {
        lock (_gate) return _state;
    }

    /// <summary>Delivers the current state to the new listener first, then each state change after commit.</summary>
    public IDisposable OnState(Action<TState> listener)
    {
        TState current;
        lock (_gate)
        {
            _stateListeners.Add(listener);
            current = _state;
        }
        Deliver(() => listener(current));
        return new Subscription(() =>
        {
            lock (_gate) _stateListeners.Remove(listener);
        });
    }

    /// <summary>Delivers one record per committed transition, in commit order, from the time of subscription.</summary>
    public IDisposable OnTransition(Action<TransitionRecord> listener)
    {
        lock (_gate) _transitionListeners.Add(listener);
        return new Subscription(() =>
        {
            lock (_gate) _transitionListeners.Remove(listener);
        });
    }

    public ICommandRun Execute(string uri, JsonNode? parameters, ExecutionContext ctx)
    {
        lock (_gate) return Begin(uri, parameters?.DeepClone(), ctx);
    }

    /// <summary>
    /// Asks, without running anything, whether a command could run with these parameters for this caller.
    /// Covers both scopes: availability (state and caller) and validity (the parameters).
    /// </summary>
    public CheckResult Check(string uri, JsonNode? parameters, ExecutionContext ctx)
    {
        lock (_gate)
        {
            var parsed = KernelUri.Parse(uri, "command", ctx.FocusCommandPath ?? "/");
            if (parsed.Ref is null) return new CheckResult(false, false, parsed.Reason);

            var target = parsed.Ref.Uri;
            if (!_commands.TryGetValue(target, out var cmd)) return new CheckResult(false, false, $"No command at {target}");

            var availability = cmd.IsAvailable(_state, ctx, parameters);
            if (!availability.Available)
            {
                return new CheckResult(false, false, availability.Reason ?? "Command is not available");
            }

            var validation = cmd.Validate(_state, parameters, ctx);
            if (!validation.Valid)
            {
                var issues = validation.Issues ?? [];
                var reason = issues.Count == 0 ? "Validation failed" : string.Join("; ", issues.Select(i => i.Message));
                return new CheckResult(true, false, reason, issues);
            }
            return new CheckResult(true, true);
        }
    }

    public ReadResult ReadState(string uri, ExecutionContext ctx)
    {
        lock (_gate)
        {
            var parsed = KernelUri.Parse(uri, "state", ctx.FocusStatePath ?? "/");
            if (parsed.Ref is null) return ReadResult.Denied(ErrorCodes.InvalidUri, parsed.Reason!);

            var found = FindMount(parsed.Ref.Segments);
            if (found is null) return ReadResult.Denied(ErrorCodes.NotFound, $"No state mount at {parsed.Ref.Uri}");

            var decision = Decide(found.Value.Mount, ctx);
            if (decision == ReadDecision.Deny)
            {
                return ReadResult.Denied(ErrorCodes.Denied, "Denied by read policy");
            }
            if (decision == ReadDecision.Mask)
            {
                return new ReadResult(true, parsed.Ref.Uri, JsonValue.Create(Mask), true, null, null);
            }
            var data = found.Value.Mount.Select(_state, found.Value.Parameters);
            return new ReadResult(true, parsed.Ref.Uri, data, false, null, null);
        }
    }

    public IReadOnlyList<CommandSummary> ListCommands(string glob, ExecutionContext ctx, bool includeUnavailable = false)
    {
        lock (_gate)
        {
            var result = new List<CommandSummary>();
            foreach (var cmd in _commands.Values)
            {
                if (!KernelUri.MatchesGlob(cmd.Uri, glob)) continue;
                var availability = cmd.IsAvailable(_state, ctx, null);
                if (!availability.Available && !includeUnavailable) continue;
                result.Add(new CommandSummary(cmd.Uri, cmd.Label, cmd.Description, availability.Available, availability.Reason));
            }
            return result;
        }
    }

    public IReadOnlyList<MountSummary> ListMounts(string glob, ExecutionContext ctx)
    {
        lock (_gate)
        {
            var result = new List<MountSummary>();
            foreach (var entry in _mounts)
            {
                var mount = entry.Mount;
                if (!KernelUri.MatchesGlob(mount.Uri, glob)) continue;
                var decision = Decide(mount, ctx);
                if (decision == ReadDecision.Deny) continue;
                result.Add(new MountSummary(mount.Uri, mount.Description, mount.Classification, decision == ReadDecision.Mask));
            }
            return result;
        }
    }

    // --- Lifecycle -----------------------------------------------------------

    private Run Begin(string raw, JsonNode? parameters, ExecutionContext ctx)
    {
        var parsed = KernelUri.Parse(raw, "command", ctx.FocusCommandPath ?? "/");
        if (parsed.Ref is null) return Rejected(raw, ErrorCodes.InvalidUri, parsed.Reason!);

        var uri = parsed.Ref.Uri;
        if (!_commands.TryGetValue(uri, out var cmd)) return Rejected(uri, ErrorCodes.NotFound, $"No command at {uri}");

        var availability = cmd.IsAvailable(_state, ctx, parameters);
        if (!availability.Available)
        {
            return Rejected(uri, ErrorCodes.CannotExecute, availability.Reason ?? "Command is not available");
        }

        var validation = cmd.Validate(_state, parameters, ctx);
        if (!validation.Valid)
        {
            var issues = validation.Issues ?? [];
            var reason = issues.Count == 0 ? "Validation failed" : string.Join("; ", issues.Select(i => i.Message));
            return Rejected(uri, ErrorCodes.ValidationFailed, reason, issues);
        }

        var run = new Run(_gate, uri);

        Task<JsonNode?> pending;
        try
        {
            pending = cmd.Handle(parameters, ctx, run.Cancellation.Token);
        }
        catch (Exception error)
        {
            pending = Task.FromException<JsonNode?>(error);
        }

        _ = pending.ContinueWith(task =>
        {
            lock (_gate)
            {
                if (task.IsFaulted)
                {
                    run.Finish(Failed(uri, ErrorCodes.ExecutionError, task.Exception?.GetBaseException().Message ?? "Handler failed"));
                }
                else if (task.IsCanceled)
                {
                    run.Finish(Failed(uri, ErrorCodes.ExecutionError, "Handler was canceled"));
                }
                else
                {
                    Commit(run, cmd, parameters, task.Result, ctx);
                }
            }
        });

        return run;
    }

    private void Commit(Run run, CommandDescriptor<TState> cmd, JsonNode? parameters, JsonNode? result, ExecutionContext ctx)
    {
        if (run.Outcome is not null) return;

        ReduceOutput<TState> output;
        List<string> affected;
        try
        {
            output = cmd.Reduce(_state, parameters, result, ctx);
            affected = output.AffectedStateUris.Select(uri =>
            {
                var parsed = KernelUri.Parse(uri, "state", ctx.FocusStatePath ?? "/");
                if (parsed.Ref is null) throw new InvalidOperationException(parsed.Reason);
                return parsed.Ref.Uri;
            }).ToList();
        }
        catch (Exception error)
        {
            run.Finish(Failed(run.CommandUri, ErrorCodes.ExecutionError, error.Message));
            return;
        }

        _state = output.NextState;
        var record = new TransitionRecord(
            run.CommandUri,
            parameters,
            output.Summary,
            affected,
            output.Inverse is null ? null : new CommandInvocation(Canonical(output.Inverse.Uri, ctx), output.Inverse.Params),
            ctx.Actor,
            ctx.DelegationChain.ToList(),
            ctx.CorrelationId);

        run.Finish(new RunOutcome(RunStatus.Completed, run.CommandUri, Result: result, Summary: output.Summary));

        var state = _state;
        foreach (var listener in _stateListeners.ToList())
        {
            var l = listener;
            Deliver(() => l(state));
        }
        foreach (var listener in _transitionListeners.ToList())
        {
            var l = listener;
            Deliver(() => l(record));
        }
    }

    /// <summary>
    /// Delivery never blocks the kernel. Tasks run in the order they were queued, one at a time. A listener
    /// that throws goes to the error sink and nothing else changes.
    /// </summary>
    private void Deliver(Action task)
    {
        Action guarded = () =>
        {
            try
            {
                task();
            }
            catch (Exception error)
            {
                _onListenerError(error);
            }
        };

        if (_scheduler is not null)
        {
            _scheduler(guarded);
            return;
        }

        lock (_queueGate)
        {
            _deliveries.Enqueue(guarded);
            if (_draining) return;
            _draining = true;
        }
        ThreadPool.QueueUserWorkItem(_ => Drain());
    }

    private void Drain()
    {
        while (true)
        {
            Action next;
            lock (_queueGate)
            {
                if (_deliveries.Count == 0)
                {
                    _draining = false;
                    return;
                }
                next = _deliveries.Dequeue();
            }
            next();
        }
    }

    // --- Helpers -------------------------------------------------------------

    private static string Canonical(string uri, ExecutionContext ctx)
    {
        var parsed = KernelUri.Parse(uri, "command", ctx.FocusCommandPath ?? "/");
        return parsed.Ref?.Uri ?? uri;
    }

    private ReadDecision Decide(MountDescriptor<TState> mount, ExecutionContext ctx) =>
        _readPolicy(mount.Classification, ctx);

    private (MountDescriptor<TState> Mount, Dictionary<string, string> Parameters)? FindMount(IReadOnlyList<string> segments)
    {
        foreach (var entry in _mounts)
        {
            var parameters = KernelUri.MatchTemplate(entry.Segments, segments);
            if (parameters is not null) return (entry.Mount, parameters);
        }
        return null;
    }

    private static Run Rejected(string commandUri, string code, string reason, IReadOnlyList<Issue>? issues = null)
    {
        var run = new Run(new object(), commandUri);
        run.Finish(Failed(commandUri, code, reason, issues));
        return run;
    }

    private static RunOutcome Failed(string commandUri, string code, string reason, IReadOnlyList<Issue>? issues = null) =>
        new(RunStatus.Failed, commandUri, code, reason, issues);

    private sealed class Subscription(Action dispose) : IDisposable
    {
        private bool _disposed;

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            dispose();
        }
    }
}
