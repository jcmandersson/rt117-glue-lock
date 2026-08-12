#!/usr/bin/env node
/**
 * Hämtar en API-nyckel från Glue Home.
 *
 * Kör: npm run glue:api-key
 *
 * Skriptet frågar efter e-post och lösenord till Glue-kontot, byter dem mot en
 * långlivad API-nyckel och skriver ut nyckeln. Lösenordet skickas bara till
 * Glue, sparas ingenstans och syns inte när du skriver det.
 *
 * Lägg sedan nyckeln som secret:
 *   npx wrangler secret put GLUE_API_KEY
 */

import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";

const API_URL = "https://user-api.gluehome.com/v1/api-keys";

// Styrtecken via teckenkod, så källkoden inte innehåller råa kontrollbytes.
const CTRL_C = String.fromCharCode(3);
const CTRL_D = String.fromCharCode(4);
const BACKSPACE = String.fromCharCode(127);

function ask(question) {
  const rl = createInterface({ input: stdin, output: stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Läser in utan att eka tecknen till terminalen. */
function askHidden(question) {
  return new Promise((resolve, reject) => {
    if (!stdin.isTTY) {
      reject(new Error("Ingen terminal. Kör skriptet interaktivt."));
      return;
    }

    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let value = "";

    const finish = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      stdout.write("\n");
    };

    const onData = (char) => {
      if (char === "\r" || char === "\n" || char === CTRL_D) {
        finish();
        resolve(value);
      } else if (char === CTRL_C) {
        finish();
        process.exit(130);
      } else if (char === BACKSPACE || char === "\b") {
        value = value.slice(0, -1);
      } else {
        value += char;
      }
    };

    stdin.on("data", onData);
  });
}

const email = await ask("Glue-konto (e-post): ");
const password = await askHidden("Lösenord (syns inte): ");

if (!email || !password) {
  console.error("\nBåde e-post och lösenord behövs.");
  process.exit(1);
}

const response = await fetch(API_URL, {
  method: "POST",
  headers: {
    Authorization: `Basic ${Buffer.from(`${email}:${password}`).toString("base64")}`,
    "Content-Type": "application/json",
    "User-Agent": "rt117-glue-lock/0.1",
  },
  body: JSON.stringify({
    name: `rt117-glue-lock (${new Date().toISOString().slice(0, 10)})`,
    scopes: ["locks.read", "locks.write", "events.read"],
  }),
});

if (response.status === 401) {
  console.error("\nGlue avvisade inloggningen. Kontrollera e-post och lösenord.");
  process.exit(1);
}

if (!response.ok) {
  console.error(`\nGlue svarade ${response.status}:`);
  console.error((await response.text()).slice(0, 1000));
  process.exit(1);
}

const { apiKey } = await response.json();
if (!apiKey) {
  console.error("\nInget apiKey i svaret. Glue kan ha ändrat sitt API.");
  process.exit(1);
}

console.log("\nAPI-nyckel:\n");
console.log(apiKey);
console.log("\nLägg in den som secret:");
console.log("  npx wrangler secret put GLUE_API_KEY");
console.log("\nLista sedan låsen för att hitta rätt lock-id:");
console.log("  GLUE_API_KEY='<nyckeln ovan>' npm run glue:locks");
