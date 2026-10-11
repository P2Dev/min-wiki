# Markdown guide

Plain text, with just enough structure. Use Markdown to make your ideas easy to read and easy to maintain.

## Headings and emphasis

Start a page with one `# Title`. Use `##` for sections and `###` for smaller subsections. Headings automatically appear in the page outline.

Use **bold** for emphasis, *italics* for a lighter distinction, and `inline code` for names or commands.

## Links between pages

Link to another Markdown file using its slug:

```markdown
[Welcome](welcome.md)
[Connect your tools](welcome.md#connect-your-tools)
```

These links open the rendered wiki page. You can also link to a full web address or a `/wiki/page-slug` path.

## Lists and quotes

1. Explain the goal.
2. Put the steps in order.
3. Describe what success looks like.

> A little context can save the next reader a lot of time.

## Code examples

Wrap a block in three backticks. Add a language name to describe the example.

```javascript
const response = await fetch('http://127.0.0.1:3000/api/pages');
const { pages } = await response.json();
console.log(pages.map(page => page.title));
```

## Tables

| Element | Markdown | Use it for |
| --- | --- | --- |
| Heading | `## Section` | Giving the page structure |
| Link | `[Label](welcome.md)` | Connecting related ideas |
| Code | Backticks | Commands and examples |

## Keep it portable

Raw HTML is shown as text. Scripts and embedded interactive components are not supported. Code and wide tables scroll within the article on small screens.

Your files do not need frontmatter. The first top-level heading supplies the page title, and the rest is ordinary Markdown.
