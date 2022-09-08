// @ts-check
const axios = require("axios").default;
const githubUsernameRegex = require("github-username-regex");

const retryer = require("../common/retryer");
const calculateRank = require("../calculateRank");
const {
  request,
  logger,
  CustomError,
  MissingParamError,
} = require("../common/utils");

require("dotenv").config();

/**
 * @param {import('axios').AxiosRequestHeaders} variables
 * @param {string} token
 */
const fetcher = (variables, token) => {
  return request(
    {
      query: `
      query userInfo($login: String!, $ownerAffiliations: [RepositoryAffiliation]) {
        user(login: $login) {
          name
          login
          contributionsCollection {
            contributionYears
            totalCommitContributions
            restrictedContributionsCount
          }
          repositoriesContributedTo(includeUserRepositories: true) {
            totalCount
          }
          pullRequests(first: 1) {
            totalCount
          }
          openIssues: issues(states: OPEN) {
            totalCount
          }
          closedIssues: issues(states: CLOSED) {
            totalCount
          }
          followers {
            totalCount
          }
          repositories(first: 100, ownerAffiliations: $ownerAffiliations, orderBy: {direction: DESC, field: STARGAZERS}) {
            totalCount
            nodes {
              stargazers {
                totalCount
              }
            }
          }
        }
      }
      `,
      variables,
    },
    {
      Authorization: `bearer ${token}`,
    },
  );
};

/**
 * @param {any} variables
 * @param {string} token
 */
const allCommitsFetcher = async (variables, token) => {
  // FETCH ALL COMMITS
  const commitPromises = variables.contributionYears.map(async (year) => {
    // Don't fetch contributions older than 2008 (Perf optimization)
    if (year < 2008) {
      return {
        user: { contributionsCollection: { totalCommitContributions: 0 } },
      };
    }

    const currentDate = new Date();
    currentDate.setFullYear(year, 0, 0);

    const res = await axios({
      url: "https://api.github.com/graphql",
      method: "post",
      headers: {
        Authorization: `bearer ${token}`,
      },
      data: {
        query: `
        query userInfo($login: String!, $from: DateTime!) {
          user(login: $login) {
            contributionsCollection(from: $from) {
              totalCommitContributions
              totalPullRequestContributions
              totalPullRequestReviewContributions
            }
          }
        }
      `,
        variables: {
          login: variables.login,
          from: currentDate.toISOString(),
        },
      },
    });

    return res.data.data;
  });

  const allCommits = await Promise.all(commitPromises);

  const result = allCommits.reduce(
    (preYear, currYear) => ({
      totalCommitContributions:
        preYear.totalCommitContributions +
        currYear.user.contributionsCollection.totalCommitContributions,
      totalPullRequestContributions:
        preYear.totalPullRequestContributions +
        currYear.user.contributionsCollection.totalPullRequestContributions,
      totalPullRequestReviewContributions:
        preYear.totalPullRequestReviewContributions +
        currYear.user.contributionsCollection
          .totalPullRequestReviewContributions,
    }),
    {
      totalCommitContributions: 0,
      totalPullRequestContributions: 0,
      totalPullRequestReviewContributions: 0,
    },
  );

  return { data: result };
};

/**
 * @param {string} username
 * @param {boolean} count_private
 * @param {boolean} include_all_commits
 * @returns {Promise<import("./types").StatsData>}
 */
async function fetchStats(
  username,
  ownerAffiliations,
  count_private = false,
  include_all_commits = false,
) {
  if (!username) throw new MissingParamError(["username"]);

  const stats = {
    name: "",
    totalPRs: 0,
    totalCommits: 0,
    totalIssues: 0,
    totalStars: 0,
    contributedTo: 0,
    rank: { level: "C", score: 0 },
  };

  // Set default value for ownerAffiliations in GraphQL query won't work because
  // parseArray() will always return an empty array even nothing was specified
  // and GraphQL would consider that empty arr as a valid value. Nothing will be
  // queried in that case as no affiliation is presented.
  ownerAffiliations =
    ownerAffiliations.length > 0 ? ownerAffiliations : ["OWNER"];
  let res = await retryer(fetcher, { login: username, ownerAffiliations });

  if (res.data.errors) {
    logger.error(res.data.errors);
    throw new CustomError(
      res.data.errors[0].message || "Could not fetch user",
      CustomError.USER_NOT_FOUND,
    );
  }

  const user = res.data.data.user;

  stats.name = user.name || user.login;
  stats.totalIssues = user.openIssues.totalCount + user.closedIssues.totalCount;

  // if include_all_commits then just get that,
  // since totalCommitsFetcher already sends totalCommits no need to +=
  if (include_all_commits) {
    const { data } = await retryer(allCommitsFetcher, {
      login: username,
      contributionYears:
        res.data.data.user.contributionsCollection.contributionYears,
    });

    stats.totalCommits = data.totalCommitContributions;
    stats.totalPRsReviewed = data.totalPullRequestReviewContributions;
  } else {
    // normal commits
    stats.totalCommits = user.contributionsCollection.totalCommitContributions;

    // if count_private then add private commits to totalCommits so far.
    if (count_private) {
      stats.totalCommits +=
        user.contributionsCollection.restrictedContributionsCount;
    }
  }

  stats.totalPRs = user.pullRequests.totalCount;
  stats.contributedTo = user.repositoriesContributedTo.totalCount;

  stats.totalStars = user.repositories.nodes.reduce((prev, curr) => {
    return prev + curr.stargazers.totalCount;
  }, 0);

  stats.rank = calculateRank({
    totalCommits: stats.totalCommits,
    totalRepos: user.repositories.totalCount,
    followers: user.followers.totalCount,
    contributions: stats.contributedTo,
    stargazers: stats.totalStars,
    prs: stats.totalPRs,
    issues: stats.totalIssues,
  });

  return stats;
}

module.exports = fetchStats;
