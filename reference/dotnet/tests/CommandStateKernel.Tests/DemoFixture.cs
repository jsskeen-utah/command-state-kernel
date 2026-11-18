using System.Text.Json.Nodes;
using CommandStateKernel;

namespace CommandStateKernel.Tests;

public sealed record DemoState(long Count, string Label, string Email, string Token, string? LockOwner);

public sealed class DemoHarness
{
    public required CommandStateKernel<DemoState> Kernel { get; init; }

    public required Dictionary<string, int> Calls { get; init; }
}

/// <summary>Mirrors kernel/ts/test/fixture.ts. Behaviour must stay identical to the TypeScript fixture.</summary>
public static class DemoFixture
{
    private static readonly Dictionary<string, object> Docs = new() { ["d1"] = "Spec" };

    public static DemoHarness Create(IReadOnlyDictionary<string, ReadDecision> policy, Scheduler? scheduler = null)
    {
        var calls = new Dictionary<string, int>();
        var kernel = new CommandStateKernel<DemoState>(
            new DemoState(0, "initial", "alice@example.com", "", null),
            new KernelOptions
            {
                Scheduler = scheduler,
                ReadPolicy = (classification, _) => policy.TryGetValue(classification, out var d) ? d : ReadDecision.Deny,
            });

        var ready = new Availability(true);

        void Counter(string uri, int sign, string inverseUri, int delayMs = 0)
        {
            kernel.RegisterCommand(new CommandDescriptor<DemoState>
            {
                Uri = uri,
                Description = uri,
                IsAvailable = (state, ctx, p) => ctx.Actor.Id == "anon"
                    ? new Availability(false, "Anonymous callers cannot change the counter")
                    : sign > 0 || p is null || state.Count >= By(p)
                        ? ready
                        : new Availability(false, "Count is below the amount to remove"),
                Validate = (_, p, _) => Positive(p),
                Handle = Tracked(uri, calls, async (p, _, _) =>
                {
                    if (delayMs > 0) await Task.Delay(delayMs);
                    return JsonValue.Create(By(p));
                }),
                Reduce = (state, p, _, _) =>
                {
                    var by = By(p);
                    return new ReduceOutput<DemoState>(
                        state with { Count = state.Count + sign * by },
                        $"{(sign > 0 ? "Added" : "Removed")} {by}",
                        ["state:/counter"],
                        new CommandInvocation(inverseUri, new JsonObject { ["by"] = by }));
                },
            });
        }

        Counter("command:/counter/increment", 1, "command:/counter/decrement");
        Counter("command:/counter/decrement", -1, "command:/counter/increment");
        Counter("command:/counter/slow-increment", 1, "command:/counter/slow-decrement", 20);
        Counter("command:/counter/slow-decrement", -1, "command:/counter/slow-increment", 20);

        kernel.RegisterCommand(new CommandDescriptor<DemoState>
        {
            Uri = "command:/counter/fail",
            Description = "command:/counter/fail",
            Handle = Tracked("command:/counter/fail", calls, async (_, _, _) =>
            {
                await Task.CompletedTask;
                throw new InvalidOperationException("boom");
            }),
            Reduce = (state, _, _, _) => new ReduceOutput<DemoState>(state, "", []),
        });

        kernel.RegisterCommand(new CommandDescriptor<DemoState>
        {
            Uri = "command:/counter/hang",
            Description = "command:/counter/hang",
            Handle = Tracked("command:/counter/hang", calls, (_, _, _) => new TaskCompletionSource<JsonNode?>().Task),
            Reduce = (state, _, _, _) => new ReduceOutput<DemoState>(state, "", []),
        });

        kernel.RegisterCommand(new CommandDescriptor<DemoState>
        {
            Uri = "command:/counter/not-ready",
            Description = "command:/counter/not-ready",
            IsAvailable = (_, _, _) => new Availability(false, "Service offline"),
            Handle = Tracked("command:/counter/not-ready", calls, (_, _, _) => Task.FromResult<JsonNode?>(JsonValue.Create(0))),
            Reduce = (state, _, _, _) => new ReduceOutput<DemoState>(state, "", []),
        });

        kernel.RegisterCommand(new CommandDescriptor<DemoState>
        {
            Uri = "command:/counter/bad-reduce",
            Description = "command:/counter/bad-reduce",
            Handle = Tracked("command:/counter/bad-reduce", calls, (_, _, _) => Task.FromResult<JsonNode?>(JsonValue.Create(1))),
            Reduce = (_, _, _, _) => throw new InvalidOperationException("reducer broke"),
        });

        kernel.RegisterCommand(new CommandDescriptor<DemoState>
        {
            Uri = "command:/label/set",
            Description = "command:/label/set",
            Validate = (_, p, _) => p is JsonObject { } o && o["label"] is JsonValue v && v.TryGetValue<string>(out _)
                ? new Validation(true)
                : new Validation(false, [new Issue("must be a string", "label")]),
            Handle = Tracked("command:/label/set", calls, (p, _, _) => Task.FromResult<JsonNode?>(p!["label"]!.DeepClone())),
            Reduce = (state, p, _, _) =>
            {
                var label = p!["label"]!.GetValue<string>();
                return new ReduceOutput<DemoState>(
                    state with { Label = label },
                    $"Label set to {label}",
                    ["state:/label"],
                    new CommandInvocation("command:/label/set", new JsonObject { ["label"] = state.Label }));
            },
        });

        kernel.RegisterCommand(new CommandDescriptor<DemoState>
        {
            Uri = "command:/auth/set-token",
            Description = "command:/auth/set-token",
            Handle = Tracked("command:/auth/set-token", calls, (p, _, _) => Task.FromResult<JsonNode?>(p!["token"]!.DeepClone())),
            Reduce = (state, p, _, _) => new ReduceOutput<DemoState>(
                state with { Token = p!["token"]!.GetValue<string>() },
                "Token updated",
                ["state:/auth/token"]),
        });

        kernel.RegisterCommand(new CommandDescriptor<DemoState>
        {
            Uri = "command:/lock/engage",
            Description = "command:/lock/engage",
            IsAvailable = (state, _, _) => state.LockOwner is null ? ready : new Availability(false, "Lock already held"),
            Handle = Tracked("command:/lock/engage", calls, (_, _, _) => Task.FromResult<JsonNode?>(null)),
            Reduce = (state, _, _, ctx) => new ReduceOutput<DemoState>(
                state with { LockOwner = ctx.Actor.Id },
                $"Lock engaged by {ctx.Actor.Id}",
                ["state:/lock/owner"],
                new CommandInvocation("command:/lock/release", new JsonObject())),
        });

        kernel.RegisterCommand(new CommandDescriptor<DemoState>
        {
            Uri = "command:/lock/release",
            Description = "command:/lock/release",
            IsAvailable = (state, ctx, _) => state.LockOwner == ctx.Actor.Id
                ? ready
                : new Availability(false, "Only the lock owner can release"),
            Handle = Tracked("command:/lock/release", calls, (_, _, _) => Task.FromResult<JsonNode?>(null)),
            Reduce = (state, _, _, _) => new ReduceOutput<DemoState>(
                state with { LockOwner = null },
                "Lock released",
                ["state:/lock/owner"],
                new CommandInvocation("command:/lock/engage", new JsonObject())),
        });

        kernel.RegisterMount(new MountDescriptor<DemoState>
        {
            Uri = "state:/counter",
            Description = "Counter",
            Classification = "public",
            Select = (s, _) => JsonValue.Create(s.Count),
        });
        kernel.RegisterMount(new MountDescriptor<DemoState>
        {
            Uri = "state:/label",
            Description = "Label",
            Classification = "internal",
            Select = (s, _) => JsonValue.Create(s.Label),
        });
        kernel.RegisterMount(new MountDescriptor<DemoState>
        {
            Uri = "state:/user/email",
            Description = "Email",
            Classification = "pii",
            Select = (s, _) => JsonValue.Create(s.Email),
        });
        kernel.RegisterMount(new MountDescriptor<DemoState>
        {
            Uri = "state:/auth/token",
            Description = "Token",
            Classification = "secret",
            Select = (s, _) => JsonValue.Create(s.Token),
        });
        kernel.RegisterMount(new MountDescriptor<DemoState>
        {
            Uri = "state:/doc/:id",
            Description = "Document",
            Classification = "internal",
            Select = (_, p) => Docs.TryGetValue(p["id"], out var title)
                ? new JsonObject { ["title"] = title.ToString() }
                : null,
        });
        kernel.RegisterMount(new MountDescriptor<DemoState>
        {
            Uri = "state:/lock/owner",
            Description = "Lock owner",
            Classification = "internal",
            Select = (s, _) => s.LockOwner is null ? null : JsonValue.Create(s.LockOwner),
        });

        return new DemoHarness { Kernel = kernel, Calls = calls };
    }

    private static Func<JsonNode?, ExecutionContext, CancellationToken, Task<JsonNode?>> Tracked(
        string uri,
        Dictionary<string, int> calls,
        Func<JsonNode?, ExecutionContext, CancellationToken, Task<JsonNode?>> handle) =>
        (p, c, t) =>
        {
            calls[uri] = calls.GetValueOrDefault(uri) + 1;
            return handle(p, c, t);
        };

    private static Validation Positive(JsonNode? p) =>
        p is JsonObject { } o && o["by"] is JsonValue v && v.TryGetValue<long>(out var n) && n > 0
            ? new Validation(true)
            : new Validation(false, [new Issue("must be positive", "by")]);

    private static long By(JsonNode? p) => p!["by"]!.GetValue<long>();
}
