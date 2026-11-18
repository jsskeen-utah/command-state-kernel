using System.Text.Json.Nodes;

namespace CommandStateKernel;

public sealed record Actor(string Id, string? DisplayName = null, string? Kind = null);

public sealed record ExecutionContext(
    Actor Actor,
    IReadOnlyList<Actor> DelegationChain,
    string? FocusCommandPath = null,
    string? FocusStatePath = null,
    string? CorrelationId = null);

public enum ReadDecision
{
    Allow,
    Mask,
    Deny,
}

public delegate ReadDecision ReadPolicy(string classification, ExecutionContext context);

public sealed record Issue(string Message, string? Field = null);

public sealed record Availability(bool Available, string? Reason = null);

public sealed record Validation(bool Valid, IReadOnlyList<Issue>? Issues = null);

public sealed record CheckResult(bool Available, bool Valid, string? Reason = null, IReadOnlyList<Issue>? Issues = null);

public sealed record CommandInvocation(string Uri, JsonNode? Params);

public sealed record ReduceOutput<TState>(
    TState NextState,
    string Summary,
    IReadOnlyList<string> AffectedStateUris,
    CommandInvocation? Inverse = null);

public enum RunStatus
{
    Started,
    Completed,
    Failed,
    Cancelled,
}

public static class ErrorCodes
{
    public const string InvalidUri = "INVALID_URI";
    public const string NotFound = "NOT_FOUND";
    public const string CannotExecute = "CANNOT_EXECUTE";
    public const string ValidationFailed = "VALIDATION_FAILED";
    public const string ExecutionError = "EXECUTION_ERROR";
    public const string Cancelled = "CANCELLED";
    public const string Denied = "DENIED";
}

public sealed record RunOutcome(
    RunStatus Status,
    string CommandUri,
    string? Code = null,
    string? Reason = null,
    IReadOnlyList<Issue>? Issues = null,
    JsonNode? Result = null,
    string? Summary = null);

public interface ICommandRun
{
    long Id { get; }
    string CommandUri { get; }
    RunStatus Status { get; }
    RunOutcome? Outcome { get; }
    Task<RunOutcome> Settled { get; }

    /// <summary>Requests cancellation. Returns true only when this call moved the run to Cancelled.</summary>
    bool Cancel();
}

/// <summary>One committed transition. Carries no sequence number and no time: adapters add those if they want them.</summary>
public sealed record TransitionRecord(
    string CommandUri,
    JsonNode? Params,
    string Summary,
    IReadOnlyList<string> AffectedStateUris,
    CommandInvocation? Inverse,
    Actor Actor,
    IReadOnlyList<Actor> DelegationChain,
    string? CorrelationId);

public sealed record ReadResult(bool Ok, string? Uri, JsonNode? Data, bool Redacted, string? Code, string? Reason)
{
    public static ReadResult Denied(string code, string reason) => new(false, null, null, false, code, reason);
}

public sealed record CommandSummary(string Uri, string? Label, string Description, bool Available, string? Reason);

public sealed record MountSummary(string Uri, string Description, string Classification, bool Redacted);

/// <summary>Runs a delivery task later. The default queues tasks onto a thread pool, one at a time, in order.</summary>
public delegate void Scheduler(Action task);

public sealed record KernelOptions
{
    /// <summary>Zero trust by default: when no policy is supplied, every classification is denied.</summary>
    public ReadPolicy? ReadPolicy { get; init; }

    public Action<Exception>? OnListenerError { get; init; }

    public Scheduler? Scheduler { get; init; }
}

public sealed class CommandDescriptor<TState>
{
    public required string Uri { get; init; }

    public string? Label { get; init; }

    public string Description { get; init; } = "";

    public Func<TState, ExecutionContext, JsonNode?, Availability> IsAvailable { get; init; } =
        (_, _, _) => new Availability(true);

    public Func<TState, JsonNode?, ExecutionContext, Validation> Validate { get; init; } =
        (_, _, _) => new Validation(true);

    public required Func<JsonNode?, ExecutionContext, CancellationToken, Task<JsonNode?>> Handle { get; init; }

    public required Func<TState, JsonNode?, JsonNode?, ExecutionContext, ReduceOutput<TState>> Reduce { get; init; }
}

public sealed class MountDescriptor<TState>
{
    public required string Uri { get; init; }

    public string Description { get; init; } = "";

    public required string Classification { get; init; }

    public required Func<TState, IReadOnlyDictionary<string, string>, JsonNode?> Select { get; init; }
}
