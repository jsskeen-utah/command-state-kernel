namespace CommandStateKernel;

internal sealed class Run : ICommandRun
{
    private static long _nextId;

    private readonly object _gate;
    private readonly TaskCompletionSource<RunOutcome> _settled =
        new(TaskCreationOptions.RunContinuationsAsynchronously);

    public Run(object gate, string commandUri)
    {
        _gate = gate;
        Id = Interlocked.Increment(ref _nextId);
        CommandUri = commandUri;
    }

    public long Id { get; }

    public string CommandUri { get; }

    public RunStatus Status { get; private set; } = RunStatus.Started;

    public RunOutcome? Outcome { get; private set; }

    public Task<RunOutcome> Settled => _settled.Task;

    public CancellationTokenSource Cancellation { get; } = new();

    public bool Finish(RunOutcome outcome)
    {
        lock (_gate)
        {
            if (Outcome is not null) return false;
            Outcome = outcome;
            Status = outcome.Status;
            _settled.TrySetResult(outcome);
            return true;
        }
    }

    public bool Cancel()
    {
        lock (_gate)
        {
            if (Status != RunStatus.Started) return false;
            Finish(new RunOutcome(RunStatus.Cancelled, CommandUri, ErrorCodes.Cancelled));
        }
        Cancellation.Cancel();
        return true;
    }
}
