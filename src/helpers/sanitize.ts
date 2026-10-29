/** Strip event-handler attributes and javascript: URLs, but only inside tags. */
const sanitizeRe = /\s+on\w+\s*=\s*("[^"]*"|'[^']*'|\S+)/gi;
const tagRe = /<\/?[a-zA-Z][\w:-]*(?:\s+[a-zA-Z_:][\w:.-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>|<\/?[a-zA-Z][^>]*>/g;
const jsUrlRe = /\s+(href|xlink:href|src|action)\s*=\s*(["'])\s*javascript:/gi;

function sanitize(html: string): string {
	return html.replace(tagRe, tag => tag.replace(sanitizeRe, '').replace(jsUrlRe, ' $1=$2'));
}

export { sanitize };