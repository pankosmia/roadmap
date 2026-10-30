// "@" suggestions for the Markdown editors of the panel, as on GitHub: people of the issue first, then the people
// who can be mentioned in its repository. Loaded before app.js; it relies on globals declared there
// (accessToken, githubRequest, currentIssue, panelMeta, panelTimeline, cachedRequest…).

const MENTIONABLE_QUERY = `query($owner: String!, $name: String!, $query: String) {
  repository(owner: $owner, name: $name) {
    mentionableUsers(first: 10, query: $query) { nodes { login name avatarUrl } }
  }
}`;
const mentionableCache = new Map();
// Display names, learned from GraphQL (the REST lists only give logins).
const mentionNames = new Map();

function mentionCandidate(user) {
  return {
    login: user.login,
    avatar_url: user.avatar_url,
    name: user.name || mentionNames.get(user.login.toLowerCase()) || ""
  };
}

// Author, then the latest commenters, then the assignees, then everyone who can be assigned in the repository.
function participantsOfIssue() {
  const issue = currentIssue();
  const users = [];
  if (issue) {
    users.push(issue.user);
    if (panelTimeline.key.startsWith(`${issue.id}|`)) {
      users.push(...allTimelineComments(panelTimeline).map((raw) => raw.user).reverse());
    }
    users.push(...(issue.assignees || []));
  }
  users.push(...(panelMeta.assignees || []));
  const seen = new Set();
  return users.filter((user) => {
    if (!user?.login || user.type === "Bot" || seen.has(user.login.toLowerCase())) return false;
    seen.add(user.login.toLowerCase());
    return true;
  });
}

// Lower is better; null means no match. Login and name prefixes come before other matches.
function mentionScore(user, query) {
  const login = user.login.toLowerCase();
  const name = user.name.toLowerCase();
  if (login.startsWith(query)) return 0;
  if (name.split(/\s+/).some((word) => word.startsWith(query))) return 1;
  if (login.includes(query)) return 2;
  if (name.includes(query)) return 3;
  return null;
}

function localMentions(query) {
  const needle = query.toLowerCase();
  return participantsOfIssue()
    .map((user, index) => ({ user: mentionCandidate(user), index }))
    .map((entry) => ({ ...entry, score: mentionScore(entry.user, needle) }))
    .filter((entry) => entry.score !== null)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((entry) => entry.user);
}

function remoteMentions(query) {
  const issue = currentIssue();
  if (!issue || !accessToken) return null;
  const [owner, name] = repoOf(issue);
  const load = async () => {
    const result = await githubRequest(
      `${API_ROOT}/graphql`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: MENTIONABLE_QUERY, variables: { owner, name, query: query || null } })
      },
      accessToken
    );
    if (result.errors?.length) throw new Error(result.errors[0].message);
    return result.data.repository.mentionableUsers.nodes.map((node) => {
      if (node.name) mentionNames.set(node.login.toLowerCase(), node.name);
      return { login: node.login, avatar_url: node.avatarUrl, name: node.name || "" };
    });
  };
  return cachedRequest(mentionableCache, `${owner}/${name}|${query.toLowerCase()}`, load);
}

const issueMentions = { local: localMentions, remote: remoteMentions };
