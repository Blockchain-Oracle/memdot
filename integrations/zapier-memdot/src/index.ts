import zapier, { defineApp } from "zapier-platform-core";
import packageJson from "../package.json" with { type: "json" };
import authentication from "./authentication.js";
import addMemory from "./creates/add-memory.js";
import deleteMemory from "./creates/delete-memory.js";
import updateMemory from "./creates/update-memory.js";
import { addAuth, handleErrors } from "./middleware.js";
import getMemory from "./searches/get-memory.js";
import searchMemories from "./searches/search-memories.js";
import listNamespaces from "./triggers/list-namespaces.js";
import newMemory from "./triggers/new-memory.js";

export default defineApp({
  version: packageJson.version,
  platformVersion: zapier.version,
  authentication,
  beforeRequest: [addAuth],
  afterResponse: [handleErrors],
  triggers: {
    [newMemory.key]: newMemory,
    [listNamespaces.key]: listNamespaces,
  },
  creates: {
    [addMemory.key]: addMemory,
    [updateMemory.key]: updateMemory,
    [deleteMemory.key]: deleteMemory,
  },
  searches: {
    [searchMemories.key]: searchMemories,
    [getMemory.key]: getMemory,
  },
});
