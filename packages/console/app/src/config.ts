/**
 * Application-wide constants and configuration
 */
export const config = {
  // Base URL — Orchestra has no own domain; the repository is the canonical home.
  baseUrl: "https://github.com/NeiP4n/orchestra-app",

  // GitHub
  github: {
    repoUrl: "https://github.com/NeiP4n/orchestra-app",
    starsFormatted: {
      compact: "205K",
      full: "205,000",
    },
  },

  // Social links — Orchestra has no X/Discord accounts; both point at the repository.
  social: {
    twitter: "https://github.com/NeiP4n/orchestra-app",
  },

  // Static stats (used on landing page)
  stats: {
    contributors: "950",
    commits: "13,000",
    monthlyUsers: "16M",
  },
} as const
