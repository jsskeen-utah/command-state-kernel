using System.Text.RegularExpressions;

namespace CommandStateKernel;

public sealed record ParsedRef(string Scheme, string Uri, IReadOnlyList<string> Segments);

public sealed record ParseResult(ParsedRef? Ref, string? Reason);

public static class KernelUri
{
    private static readonly Regex SchemePattern = new(@"^(command|state):(.*)$", RegexOptions.Singleline);
    private static readonly Regex CanonicalPattern = new(@"^(command|state):/(.*)$", RegexOptions.Singleline);
    private static readonly Regex SegmentPattern = new(@"^[a-z][a-z0-9-]*$");
    private static readonly Regex ParamPattern = new(@"^:[a-z][a-z0-9-]*$");

    public static ParseResult Parse(string? raw, string scheme, string focusPath = "/", bool templates = false)
    {
        if (raw is null) return Fail("URI must be a string");

        var match = SchemePattern.Match(raw);
        if (!match.Success) return Fail($"Expected \"command:\" or \"state:\" scheme: {raw}");
        if (match.Groups[1].Value != scheme) return Fail($"Scheme mismatch: expected {scheme}: in {raw}");

        var rest = match.Groups[2].Value;
        if (rest.StartsWith("//", StringComparison.Ordinal)) return Fail($"Authority syntax is forbidden: {raw}");

        var absolute = rest.StartsWith('/');
        var source = absolute ? rest : $"{focusPath.TrimEnd('/')}/{rest}";
        var stack = new List<string>();

        foreach (var segment in source.Split('/'))
        {
            if (segment is "" or ".") continue;
            if (segment == "..")
            {
                if (stack.Count == 0) return Fail($"Reference climbs above the root: {raw}");
                stack.RemoveAt(stack.Count - 1);
                continue;
            }
            var valid = SegmentPattern.IsMatch(segment) || (templates && ParamPattern.IsMatch(segment));
            if (!valid) return Fail($"Invalid segment \"{segment}\" in {raw}");
            stack.Add(segment);
        }

        var uri = $"{scheme}:/{string.Join('/', stack)}";
        return new ParseResult(new ParsedRef(scheme, uri, stack), null);
    }

    public static bool MatchesGlob(string canonicalUri, string glob)
    {
        var uri = CanonicalPattern.Match(canonicalUri);
        var pattern = CanonicalPattern.Match(glob);
        if (!uri.Success || !pattern.Success || uri.Groups[1].Value != pattern.Groups[1].Value) return false;

        var path = Split(uri.Groups[2].Value);
        var globSegments = Split(pattern.Groups[2].Value);
        return MatchSegments(path, globSegments, 0, 0);
    }

    public static Dictionary<string, string>? MatchTemplate(IReadOnlyList<string> template, IReadOnlyList<string> segments)
    {
        if (template.Count != segments.Count) return null;
        var parameters = new Dictionary<string, string>(StringComparer.Ordinal);
        for (var i = 0; i < template.Count; i++)
        {
            var part = template[i];
            if (part.StartsWith(':'))
            {
                parameters[part[1..]] = segments[i];
            }
            else if (part != segments[i])
            {
                return null;
            }
        }
        return parameters;
    }

    private static string[] Split(string path) => path.Length == 0 ? [] : path.Split('/');

    private static bool MatchSegments(string[] path, string[] glob, int p, int g)
    {
        if (g == glob.Length) return p == path.Length;
        var pattern = glob[g];
        if (pattern == "**")
        {
            for (var next = p; next <= path.Length; next++)
            {
                if (MatchSegments(path, glob, next, g + 1)) return true;
            }
            return false;
        }
        if (p == path.Length) return false;
        if (pattern == "*" || pattern == path[p]) return MatchSegments(path, glob, p + 1, g + 1);
        return false;
    }

    private static ParseResult Fail(string reason) => new(null, reason);
}
