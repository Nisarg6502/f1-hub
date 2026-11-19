import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AccountBenefits from "@/components/account/account-benefits";

describe("AccountBenefits", () => {
  const html = renderToStaticMarkup(createElement(AccountBenefits));
  // Entities (apostrophes) are escaped in markup; compare on the text.
  const text = html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

  it("lists the four things an account adds, in the visitor's terms", () => {
    expect(text).toContain("Race reminders");
    expect(text).toContain("An email before qualifying and the race, in your time zone.");
    expect(text).toContain("Spoiler-free on every device");
    expect(text).toContain("Hide results until you've watched, on your phone and laptop alike.");
    expect(text).toContain("Your home, your favourites");
    expect(text).toContain("Your layout, driver and team follow you everywhere.");
    expect(text).toContain("Saved conversations");
    expect(text).toContain("Come back to your Pitwall Assistant chats later.");
  });

  it("says it is free, passwordless, and optional", () => {
    expect(text).toContain("Free, no password, and everything else works without an account.");
  });

  it("is a list of exactly four", () => {
    expect(html.match(/<li/g)).toHaveLength(4);
  });

  it("hides its decorative icons from screen readers", () => {
    expect(html.match(/aria-hidden="true"/g)?.length).toBeGreaterThanOrEqual(4);
  });
});
