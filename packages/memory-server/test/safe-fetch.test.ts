import assert from "node:assert/strict";
import { test } from "node:test";
import { isPrivateAddress } from "../src/safe-fetch.js";

test("addresses inside a network are refused, however they're written", () => {
  for (const address of [
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254",
    "192.168.1.1",
    "::",
    "::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "fe80::1%en0",
    "fec0::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:a9fe:a9fe",
    "::7f00:1",
    "64:ff9b::7f00:1",
    "64:ff9b::a9fe:a9fe",
    "2002:7f00:1::",
    "2002:a9fe:a9fe::1",
  ]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
});

test("public addresses pass, including an IPv4 one in disguise", () => {
  for (const address of [
    "8.8.8.8",
    "1.1.1.1",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
    "::ffff:8.8.8.8",
    "::ffff:808:808",
    "64:ff9b::808:808",
    "2002:808:808::1",
  ]) {
    assert.equal(isPrivateAddress(address), false, address);
  }
});
