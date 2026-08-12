import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  base64UrlDecode,
  base64UrlEncode,
  pkceChallenge,
  randomDigits,
  timingSafeEqual,
} from "../src/lib/crypto";
import { normalizeEmail, normalizePhone, parseEmailList } from "../src/lib/normalize";
import { consumeRateLimit } from "../src/lib/ratelimit";
import { signSession, verifySession } from "../src/auth/session";

describe("crypto", () => {
  it("kodar och avkodar base64url utan padding", () => {
    const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255]);
    const encoded = base64UrlEncode(bytes);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(Array.from(base64UrlDecode(encoded))).toEqual(Array.from(bytes));
  });

  it("ger koder med rätt längd och bara siffror", () => {
    for (let i = 0; i < 200; i++) {
      expect(randomDigits(6)).toMatch(/^\d{6}$/);
    }
  });

  it("täcker hela intervallet, inklusive koder med inledande nolla", () => {
    const codes = new Set<string>();
    for (let i = 0; i < 4000; i++) codes.add(randomDigits(6));
    // Med 4000 dragningar ur en miljon ska dubbletter vara sällsynta.
    expect(codes.size).toBeGreaterThan(3900);
  });

  it("jämför lika strängar som lika och olika som olika", () => {
    expect(timingSafeEqual("abc123", "abc123")).toBe(true);
    expect(timingSafeEqual("abc123", "abc124")).toBe(false);
    // Olika längd får inte kasta, bara returnera false.
    expect(timingSafeEqual("abc", "abcdef")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
  });

  it("räknar ut en PKCE-utmaning som är url-säker", async () => {
    const challenge = await pkceChallenge("verifier-1234567890");
    expect(challenge).not.toMatch(/[+/=]/);
    // Samma verifier ska alltid ge samma utmaning.
    expect(await pkceChallenge("verifier-1234567890")).toBe(challenge);
    expect(await pkceChallenge("annan-verifier")).not.toBe(challenge);
  });
});

describe("normalisering", () => {
  it("gör e-post till gemener och trimmar", () => {
    expect(normalizeEmail("  Jonas@Example.COM ")).toBe("jonas@example.com");
  });

  it("avvisar skräp", () => {
    for (const bad of ["", "inte-en-adress", "a@b", "a b@c.se", "två@@c.se", "@c.se"]) {
      expect(normalizeEmail(bad)).toBeNull();
    }
  });

  it("normaliserar svenska nummer till E.164", () => {
    expect(normalizePhone("070-123 45 67")).toBe("+46701234567");
    expect(normalizePhone("0701234567")).toBe("+46701234567");
    expect(normalizePhone("+46 70 123 45 67")).toBe("+46701234567");
    expect(normalizePhone("0046701234567")).toBe("+46701234567");
    expect(normalizePhone("(070) 123 45 67")).toBe("+46701234567");
  });

  it("avvisar nummer som inte går att tolka", () => {
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone("abc")).toBeNull();
    expect(normalizePhone("123")).toBeNull();
  });

  it("läser en kommaseparerad adresslista och hoppar över skräp", () => {
    expect(parseEmailList("A@b.se, trasig, c@d.se")).toEqual(["a@b.se", "c@d.se"]);
    expect(parseEmailList(undefined)).toEqual([]);
  });
});

describe("hastighetsbegränsning", () => {
  it("släpper igenom upp till taket och stoppar därefter", async () => {
    const bucket = `test:${crypto.randomUUID()}`;

    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = await consumeRateLimit(env.DB, bucket, 3, 600);
      expect(result.allowed).toBe(true);
      expect(result.count).toBe(attempt);
    }

    const blocked = await consumeRateLimit(env.DB, bucket, 3, 600);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(0);
  });

  it("håller separata hinkar isär", async () => {
    const a = `test:${crypto.randomUUID()}`;
    const b = `test:${crypto.randomUUID()}`;
    await consumeRateLimit(env.DB, a, 1, 600);
    expect((await consumeRateLimit(env.DB, a, 1, 600)).allowed).toBe(false);
    expect((await consumeRateLimit(env.DB, b, 1, 600)).allowed).toBe(true);
  });
});

describe("sessioner", () => {
  const payload = { sub: "medlem-1", tv: 1, via: "otp" as const, exp: 4_000_000_000 };

  it("signerar och verifierar", async () => {
    const token = await signSession(env, payload);
    expect(await verifySession(env, token)).toEqual(payload);
  });

  it("avvisar manipulerat innehåll", async () => {
    const token = await signSession(env, payload);
    const [body, signature] = token.split(".");
    const forged = `${base64UrlEncode(new TextEncoder().encode(JSON.stringify({ ...payload, sub: "nagon-annan" })))}.${signature}`;
    expect(await verifySession(env, forged)).toBeNull();
    expect(await verifySession(env, `${body}.${"0".repeat(64)}`)).toBeNull();
  });

  it("avvisar utgångna och trasiga tokens", async () => {
    const expired = await signSession(env, { ...payload, exp: 1 });
    expect(await verifySession(env, expired)).toBeNull();
    expect(await verifySession(env, "skräp")).toBeNull();
    expect(await verifySession(env, "a.b.c")).toBeNull();
  });

  it("avvisar en token signerad med en annan hemlighet", async () => {
    const token = await signSession({ ...env, SESSION_SECRET: "annan-hemlighet" }, payload);
    expect(await verifySession(env, token)).toBeNull();
  });
});
