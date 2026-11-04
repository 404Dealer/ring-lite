#!/usr/bin/env node
// Signs in to your Ring account once and saves the sign-in for RingClient.
//   ring-lite-signin [--file <token file>] [--device-name <name>]
// You type your Ring email, password and the code Ring sends you. They go only to oauth.ring.com; the password is
// never shown, saved or logged. What's saved is Ring's token, readable by your account only. The client then shows
// in the Ring app under Control Center → Authorized Client Devices; removing it there ends the token.
import { parseArgs } from "node:util";
import { RingClient, defaultTokenFile, fileTokenStore, signInWithPassword } from "../index.mjs";

// Reads a line from the terminal. Hidden: shows * for each character. A password is taken exactly as typed or
// pasted (spaces included); the terminal's paste markers and arrow keys are dropped.
function ask(question, { hidden = false } = {}) {
  const { stdin, stdout } = process;
  stdout.write(question);
  return new Promise((resolve) => {
    let text = "";
    const done = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
      resolve(hidden ? text : text.trim());
    };
    const onData = (chunk) => {
      const keys = chunk
        .replace(/\x1b\[20[01]~/g, "") // the start and end of a paste
        .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") // arrow keys, Home, Delete and the like
        .replace(/\x1b./g, "");
      for (const ch of keys) {
        if (ch === "\r" || ch === "\n") return done();
        if (ch === "\u0003") {
          // Ctrl+C: give the terminal back before leaving
          stdin.setRawMode(false);
          stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") {
          if (text) {
            text = [...text].slice(0, -1).join("");
            stdout.write("\b \b");
          }
          continue;
        }
        if (ch >= " ") {
          text += ch;
          stdout.write(hidden ? "*" : ch);
        }
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    stdin.on("data", onData);
  });
}

// Returns the exit code. (Leaving with process.exit() after a hidden read crashes Node on Windows with
// "Assertion failed ... async.c", so main returns and Node ends on its own.)
async function main() {
  const { values } = parseArgs({
    options: { file: { type: "string" }, "device-name": { type: "string" }, help: { type: "boolean", short: "h" } },
  });
  if (values.help) {
    console.log("Usage: ring-lite-signin [--file <token file>] [--device-name <name>]");
    return 0;
  }
  if (!process.stdin.isTTY) {
    console.error("Run this in a terminal (not piped), so the password can be typed hidden.");
    return 1;
  }
  const file = values.file ?? defaultTokenFile();
  const deviceName = values["device-name"] ?? "ring-lite";
  const store = fileTokenStore(file);
  console.log(`Signs in to Ring. Your email, password and code go only to oauth.ring.com;
only Ring's token is kept, in ${file} (readable by you only).
`);

  const existing = await store.read();
  if (existing && !/^y/i.test(await ask("Already signed in there. Sign in again? (y/N) "))) return 0;

  const email = await ask("Ring email: ");
  let password = await ask("Ring password: ", { hidden: true });
  let token;
  try {
    token = await signInWithPassword({
      email,
      password,
      hardwareId: existing?.hardwareId, // Ring keeps seeing the same device
      askCode: ({ method, phone, attempt }) => {
        const where = method === "totp" ? "from your authenticator app" : `Ring just sent${phone ? ` to ${phone}` : ""}${method ? ` by ${method}` : ""}`;
        return ask(`${attempt ? "That code didn't work. " : ""}The code ${where}: `);
      },
    });
  } catch (e) {
    console.error(`${e.message}.`);
    return 1;
  } finally {
    password = null;
  }
  await store.write(token);
  console.log(`Signed in. Saved Ring's token to ${file}.`);

  try {
    const cameras = await new RingClient({ tokenStore: store, deviceName }).cameras();
    console.log(cameras.length
      ? `Cameras: ${cameras.map((c) => `${c.name}${c.battery !== null ? ` (battery ${c.battery}%)` : ""}`).join(", ")}.`
      : "Ring didn't list any cameras on this account.");
    console.log(`In the Ring app it shows as "${deviceName}".`);
  } catch (e) {
    console.log(`Signed in, but listing the cameras didn't work yet (${e.message}).`);
  }
  return 0;
}

process.exitCode = await main();
