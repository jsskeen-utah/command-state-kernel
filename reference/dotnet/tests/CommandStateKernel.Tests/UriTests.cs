using CommandStateKernel;
using Xunit;

namespace CommandStateKernel.Tests;

public sealed class UriTests
{
    [Fact]
    public void Star_matches_exactly_one_segment()
    {
        Assert.True(KernelUri.MatchesGlob("command:/doc/update", "command:/doc/*"));
        Assert.False(KernelUri.MatchesGlob("command:/doc/a/b", "command:/doc/*"));
    }

    [Fact]
    public void Double_star_matches_zero_or_more_segments()
    {
        Assert.True(KernelUri.MatchesGlob("command:/doc", "command:/doc/**"));
        Assert.True(KernelUri.MatchesGlob("command:/doc/a/b", "command:/doc/**"));
        Assert.False(KernelUri.MatchesGlob("command:/other/a", "command:/doc/**"));
    }

    [Fact]
    public void A_glob_never_matches_across_schemes()
    {
        Assert.False(KernelUri.MatchesGlob("state:/doc/a", "command:/**"));
        Assert.False(KernelUri.MatchesGlob("command:/doc/a", "state:/**"));
    }

    [Fact]
    public void Relative_references_resolve_against_focus_and_normalize()
    {
        var parsed = KernelUri.Parse("command:./update/../save", "command", "/doc");
        Assert.Equal("command:/doc/save", parsed.Ref!.Uri);
    }

    [Fact]
    public void References_above_the_root_are_rejected()
    {
        Assert.Null(KernelUri.Parse("command:../x", "command").Ref);
    }

    [Fact]
    public void Non_kebab_segments_are_rejected()
    {
        Assert.Null(KernelUri.Parse("command:/Doc/x", "command").Ref);
        Assert.Null(KernelUri.Parse("command:/doc/update_content", "command").Ref);
    }

    [Fact]
    public void Authority_syntax_is_rejected()
    {
        Assert.Null(KernelUri.Parse("command://doc/x", "command").Ref);
    }

    [Fact]
    public void Template_segments_are_accepted_only_when_templates_are_enabled()
    {
        Assert.Null(KernelUri.Parse("state:/doc/:id", "state").Ref);
        Assert.Equal("state:/doc/:id", KernelUri.Parse("state:/doc/:id", "state", "/", templates: true).Ref!.Uri);
    }

    [Fact]
    public void Templates_extract_parameters_and_reject_mismatches()
    {
        var parameters = KernelUri.MatchTemplate(["doc", ":id"], ["doc", "d1"]);
        Assert.Equal("d1", parameters!["id"]);
        Assert.Null(KernelUri.MatchTemplate(["doc", ":id"], ["doc"]));
        Assert.Null(KernelUri.MatchTemplate(["doc", ":id"], ["note", "d1"]));
    }
}
