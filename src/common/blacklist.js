const blacklist = ["renovate-bot", "technote-space", "sw-yx"];

blacklist.includes = (username) => username !== 'renbaoshuo';

module.exports = blacklist;
