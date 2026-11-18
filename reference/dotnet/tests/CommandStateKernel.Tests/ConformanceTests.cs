using System.Text.Json;
using System.Text.Json.Nodes;
using CommandStateKernel;
using Xunit;

namespace CommandStateKernel.Tests;

/// <summary>Executes conformance/scenarios.json. Mirrors reference/typescript/test/conformance.test.ts.</summary>
public sealed class ConformanceTests
{
    private static readonly JsonElement Root = LoadSuite();

    public static IEnumerable<object[]> ScenarioNames() =>
        Root.GetProperty("scenarios").EnumerateArray().Select(s => new object[] { s.GetProperty("name").GetString()! });

    [Theory]
    [MemberData(nameof(ScenarioNames))]
    public async Task Scenario(string name)
    {
        var scenario = Root.GetProperty("scenarios").EnumerateArray()
            .First(s => s.GetProperty("name").GetString() == name);

        var setup = scenario.TryGetProperty("setup", out var s) ? s : default;
        var policyName = setup.ValueKind == JsonValueKind.Object && setup.TryGetProperty("policy", out var p)
            ? p.GetString()!
            : "standard";
        var policy = ParsePolicy(Root.GetProperty("policies").GetProperty(policyName));

        var pending = new List<Action>();
        var harness = DemoFixture.Create(policy, task => pending.Add(task));
        var contexts = ParseContexts();
        var vars = new Dictionary<string, object>();

        foreach (var step in scenario.GetProperty("steps").EnumerateArray())
        {
            switch (Str(step, "do"))
            {
                case "await":
                    await RunOf(vars, Str(step, "as")!).Settled;
                    break;
                case "flush":
                    Flush(harness, pending);
                    break;
                default:
                    Sync(step, harness, contexts, vars);
                    break;
            }
        }
    }

    /// <summary>Runs delivered tasks in order. GetState takes the kernel's lock, so any commit in progress has finished.</summary>
    private static void Flush(DemoHarness harness, List<Action> pending)
    {
        _ = harness.Kernel.GetState();
        while (pending.Count > 0)
        {
            var task = pending[0];
            pending.RemoveAt(0);
            task();
        }
    }

    private static void Sync(JsonElement step, DemoHarness h, Dictionary<string, ExecutionContext> contexts, Dictionary<string, object> vars)
    {
        var kernel = h.Kernel;
        switch (Str(step, "do"))
        {
            case "execute":
                vars[Str(step, "as")!] = kernel.Execute(Str(step, "uri")!, Node(step, "params"), Ctx(contexts, step));
                return;
            case "cancel":
                vars[Str(step, "as")!] = RunOf(vars, Str(step, "of")!).Cancel();
                return;
            case "read":
                vars[Str(step, "as")!] = kernel.ReadState(Str(step, "uri")!, Ctx(contexts, step));
                return;
            case "check":
                vars[Str(step, "as")!] = kernel.Check(Str(step, "uri")!, Node(step, "params"), Ctx(contexts, step));
                return;
            case "checkInverse":
            {
                var record = Records(vars, Str(step, "from")!)[IntOr(step, "index", 0)];
                var inverse = record.Inverse ?? throw new InvalidOperationException("record has no inverse");
                vars[Str(step, "as")!] = kernel.Check(inverse.Uri, inverse.Params, Ctx(contexts, step));
                return;
            }
            case "executeInverse":
            {
                var record = Records(vars, Str(step, "from")!)[IntOr(step, "index", 0)];
                var inverse = record.Inverse ?? throw new InvalidOperationException("record has no inverse");
                vars[Str(step, "as")!] = kernel.Execute(inverse.Uri, inverse.Params, Ctx(contexts, step));
                return;
            }
            case "subscribe":
            {
                var list = new List<TransitionRecord>();
                kernel.OnTransition(list.Add);
                vars[Str(step, "as")!] = list;
                return;
            }
            case "subscribeState":
            {
                var list = new List<DemoState>();
                kernel.OnState(list.Add);
                vars[Str(step, "as")!] = list;
                return;
            }
            case "getState":
                vars[Str(step, "as")!] = kernel.GetState()!;
                return;
            case "list":
                vars[Str(step, "as")!] = Str(step, "kind") == "commands"
                    ? kernel.ListCommands(Str(step, "glob")!, Ctx(contexts, step), Bool(step, "includeUnavailable"))
                    : kernel.ListMounts(Str(step, "glob")!, Ctx(contexts, step));
                return;
            case "expectRun":
                ExpectRun(step, vars);
                return;
            case "expectCancel":
                Assert.Equal(Bool(step, "requested"), (bool)vars[Str(step, "as")!]);
                return;
            case "expectHandlerCalls":
                Assert.Equal(IntOr(step, "count", 0), h.Calls.GetValueOrDefault(Str(step, "uri")!));
                return;
            case "expectRead":
                ExpectRead(step, vars);
                return;
            case "expectCheck":
                ExpectCheck(step, vars);
                return;
            case "expectRecords":
                ExpectRecords(step, vars);
                return;
            case "expectState":
            {
                var state = vars[Str(step, "as")!];
                var value = state.GetType().GetProperties()
                    .First(p => string.Equals(p.Name, Str(step, "path"), StringComparison.OrdinalIgnoreCase))
                    .GetValue(state);
                Assert.Equal(Canon(Expected(step, "value")), Canon(JsonValue.Create(value)));
                return;
            }
            case "expectStates":
            {
                var states = (List<DemoState>)vars[Str(step, "as")!];
                Assert.Equal(Canon(Expected(step, "counts")), Canon(new JsonArray(states.Select(s => (JsonNode?)JsonValue.Create(s!.Count)).ToArray())));
                return;
            }
            case "expectList":
            {
                var uris = vars[Str(step, "as")!] switch
                {
                    IReadOnlyList<CommandSummary> commands => commands.Select(c => c.Uri),
                    IReadOnlyList<MountSummary> mounts => mounts.Select(m => m.Uri),
                    _ => throw new InvalidOperationException("Not a listing"),
                };
                Assert.Equal(
                    Strings(step, "uris").OrderBy(x => x, StringComparer.Ordinal).ToArray(),
                    uris.OrderBy(x => x, StringComparer.Ordinal).ToArray());
                return;
            }
            default:
                throw new InvalidOperationException($"Unknown step: {Str(step, "do")}");
        }
    }

    private static void ExpectRun(JsonElement step, Dictionary<string, object> vars)
    {
        var run = (ICommandRun)vars[Str(step, "as")!];
        Assert.Equal(Str(step, "status"), run.Status.ToString());
        var outcome = run.Outcome;
        if (step.TryGetProperty("code", out _)) Assert.Equal(Str(step, "code"), outcome?.Code);
        if (step.TryGetProperty("reason", out _)) Assert.Equal(Str(step, "reason"), outcome?.Reason);
        if (step.TryGetProperty("issues", out _)) Assert.Equal(Canon(Expected(step, "issues")), Canon(IssuesNode(outcome?.Issues)));
        if (step.TryGetProperty("result", out _)) Assert.Equal(Canon(Expected(step, "result")), Canon(outcome?.Result));
    }

    private static void ExpectRead(JsonElement step, Dictionary<string, object> vars)
    {
        var r = (ReadResult)vars[Str(step, "as")!];
        Assert.Equal(Bool(step, "ok"), r.Ok);
        if (step.TryGetProperty("code", out _)) Assert.Equal(Str(step, "code"), r.Code);
        if (step.TryGetProperty("data", out _)) Assert.Equal(Canon(Expected(step, "data")), Canon(r.Data));
        if (step.TryGetProperty("redacted", out _)) Assert.Equal(Bool(step, "redacted"), r.Redacted);
    }

    private static void ExpectCheck(JsonElement step, Dictionary<string, object> vars)
    {
        var c = (CheckResult)vars[Str(step, "as")!];
        Assert.Equal(Bool(step, "available"), c.Available);
        Assert.Equal(Bool(step, "valid"), c.Valid);
        if (step.TryGetProperty("reason", out _)) Assert.Equal(Str(step, "reason"), c.Reason);
        if (step.TryGetProperty("issues", out _)) Assert.Equal(Canon(Expected(step, "issues")), Canon(IssuesNode(c.Issues)));
    }

    private static void ExpectRecords(JsonElement step, Dictionary<string, object> vars)
    {
        var records = Records(vars, Str(step, "as")!);
        if (step.TryGetProperty("count", out _)) Assert.Equal(IntOr(step, "count", 0), records.Count);
        if (step.TryGetProperty("commandUris", out _)) Assert.Equal(Strings(step, "commandUris"), records.Select(r => r.CommandUri).ToArray());
        if (step.TryGetProperty("actors", out _)) Assert.Equal(Strings(step, "actors"), records.Select(r => r.Actor.Id).ToArray());
        if (step.TryGetProperty("firstParams", out _)) Assert.Equal(Canon(Expected(step, "firstParams")), Canon(records[0].Params));
        if (step.TryGetProperty("firstAffected", out _)) Assert.Equal(Strings(step, "firstAffected"), records[0].AffectedStateUris.ToArray());
        if (step.TryGetProperty("firstDelegation", out _))
        {
            Assert.Equal(Strings(step, "firstDelegation"), records[0].DelegationChain.Select(a => a.Id).ToArray());
        }
        if (step.TryGetProperty("firstInverse", out _))
        {
            var inverse = records[0].Inverse;
            var actual = inverse is null ? null : new JsonObject { ["uri"] = inverse.Uri, ["params"] = inverse.Params?.DeepClone() };
            Assert.Equal(Canon(Expected(step, "firstInverse")), Canon(actual));
        }
    }

    // --- Helpers -------------------------------------------------------------

    private static ICommandRun RunOf(Dictionary<string, object> vars, string name) => (ICommandRun)vars[name];

    private static List<TransitionRecord> Records(Dictionary<string, object> vars, string name) =>
        (List<TransitionRecord>)vars[name];

    private static JsonElement LoadSuite()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "scenarios.json");
        return JsonDocument.Parse(File.ReadAllText(path)).RootElement.Clone();
    }

    private static Dictionary<string, ReadDecision> ParsePolicy(JsonElement policy) =>
        policy.EnumerateObject().ToDictionary(
            p => p.Name,
            p => p.Value.GetString() switch
            {
                "allow" => ReadDecision.Allow,
                "mask" => ReadDecision.Mask,
                "deny" => ReadDecision.Deny,
                var other => throw new InvalidOperationException($"Unknown decision {other}"),
            });

    private static Dictionary<string, ExecutionContext> ParseContexts()
    {
        var result = new Dictionary<string, ExecutionContext>();
        foreach (var c in Root.GetProperty("contexts").EnumerateObject())
        {
            var v = c.Value;
            result[c.Name] = new ExecutionContext(
                ParseActor(v.GetProperty("actor")),
                v.GetProperty("delegationChain").EnumerateArray().Select(ParseActor).ToList(),
                v.TryGetProperty("focusCommandPath", out var fc) ? fc.GetString() : null,
                v.TryGetProperty("focusStatePath", out var fs) ? fs.GetString() : null);
        }
        return result;
    }

    private static Actor ParseActor(JsonElement a) => new(
        a.GetProperty("id").GetString()!,
        a.TryGetProperty("displayName", out var d) ? d.GetString() : null,
        a.TryGetProperty("kind", out var k) ? k.GetString() : null);

    private static ExecutionContext Ctx(Dictionary<string, ExecutionContext> contexts, JsonElement step) =>
        contexts[Str(step, "ctx")!];

    private static string? Str(JsonElement step, string prop) =>
        step.TryGetProperty(prop, out var v) && v.ValueKind != JsonValueKind.Null ? v.GetString() : null;

    private static bool Bool(JsonElement step, string prop) =>
        step.TryGetProperty(prop, out var v) && v.GetBoolean();

    private static int IntOr(JsonElement step, string prop, int fallback) =>
        step.TryGetProperty(prop, out var v) ? v.GetInt32() : fallback;

    private static string[] Strings(JsonElement step, string prop) =>
        step.GetProperty(prop).EnumerateArray().Select(x => x.GetString()!).ToArray();

    private static JsonNode? Node(JsonElement step, string prop) =>
        step.TryGetProperty(prop, out var v) ? JsonNode.Parse(v.GetRawText()) : null;

    private static JsonNode? Expected(JsonElement step, string prop) => Node(step, prop);

    private static JsonNode IssuesNode(IReadOnlyList<Issue>? issues)
    {
        var array = new JsonArray();
        foreach (var issue in issues ?? [])
        {
            var obj = new JsonObject();
            if (issue.Field is not null) obj["field"] = issue.Field;
            obj["message"] = issue.Message;
            array.Add(obj);
        }
        return array;
    }

    /// <summary>Canonical JSON text, so that numbers and object shapes compare by value.</summary>
    private static string Canon(JsonNode? node) => node?.ToJsonString() ?? "null";
}
