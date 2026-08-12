#!/usr/bin/env node
/**
 * Slumpar fram hemligheter till SESSION_SECRET och OTP_PEPPER.
 *
 * Kör: npm run secrets:gen
 */

import { randomBytes } from "node:crypto";

const generate = () => randomBytes(32).toString("base64url");

console.log("SESSION_SECRET =", generate());
console.log("OTP_PEPPER     =", generate());
console.log("");
console.log("Lägg in dem som secrets (klistra in värdet när wrangler frågar):");
console.log("  npx wrangler secret put SESSION_SECRET");
console.log("  npx wrangler secret put OTP_PEPPER");
console.log("");
console.log("För lokal utveckling: lägg dem i .dev.vars i stället.");
console.log("Byter du SESSION_SECRET loggas alla ut. OTP_PEPPER ogiltigförklarar utskickade koder.");
