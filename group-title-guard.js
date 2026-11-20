"use strict";

function createGroupTitleGuard(options = {}) {
  return {
    start: () => {},
    pause: () => {},
    stop: () => {},
    handleEvent: async () => {},
    repair: async () => ({ skipped: true })
  };
}

module.exports = { createGroupTitleGuard };
