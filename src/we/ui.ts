/**
 * Driving WE the way a person does. Selectors follow WE's schemas — the words and icons on screen,
 * which WE's elements reflect into the DOM — so a step fails when the thing it clicks stops
 * existing, and says which.
 */

import type { Locator, Page } from "playwright-core";

export type TranscribeState = "absent" | "off" | "starting" | "listening";

const visible = async (l: Locator, timeout = 0) => {
  try {
    await l.first().waitFor({ state: "visible", timeout });
    return true;
  } catch {
    return false;
  }
};

async function expectVisible(l: Locator, what: string, timeout: number): Promise<void> {
  if (!(await visible(l, timeout))) throw new Error(`${what} did not appear within ${timeout} ms`);
}

const button = (page: Page, text: string) => page.locator("we-button", { hasText: text });
const iconButton = (page: Page, icon: string) => page.locator("we-button", { has: page.locator(`we-icon[name="${icon}"]`) });

/** Signed in: WE either asks for a display name (first run) or shows the home page. */
export async function waitForShell(page: Page, timeoutMs: number): Promise<void> {
  const namePrompt = page.getByText("What should we call you?");
  const home = page.getByText("Your Spaces", { exact: true });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await visible(namePrompt)) || (await visible(home))) return;
    await page.waitForTimeout(500);
  }
  throw new Error(`WE did not reach its signed-in shell within ${timeoutMs} ms`);
}

/** Answers the first-run name prompt, as a new user would. */
export async function setDisplayName(page: Page, name: string): Promise<void> {
  const prompt = page.getByText("What should we call you?");
  // A moment's grace: the prompt can follow the home page rather than precede it.
  if (!(await visible(prompt, 3000))) return;
  await page.locator('we-input[placeholder="Name..."] input').first().fill(name);
  await button(page, "Save").first().click();
  await prompt.first().waitFor({ state: "hidden", timeout: 30000 });
}

export async function createSharedSpace(page: Page, name: string, timeoutMs: number): Promise<void> {
  // The rail opens under the pointer; the "+" on its Spaces heading exists only while it is open.
  const add = page.locator('we-button[aria-label="Add a space"]');
  await page.mouse.move(40, 500);
  await expectVisible(add, 'The sidebar\'s "Add a space" button', 10000);
  await add.first().click();
  await page.getByText("Create a space", { exact: true }).first().click();

  const nameField = page.locator('we-input[placeholder="Space name..."] input');
  await expectVisible(nameField, "The create-space form", 15000);
  await nameField.first().fill(name);
  await page.mouse.move(800, 20);

  // The access switch is the form's first; "Shareable space" confirms it flipped.
  await page.locator("we-modal we-switch").first().click();
  await expectVisible(page.getByText("Shareable space", { exact: true }), "The shared-space toggle", 5000);

  await button(page, "Create Space").first().click();
  // Publishing the neighbourhood installs its link language — the slow step of this flow.
  await nameField.first().waitFor({ state: "detached", timeout: timeoutMs });
}

/** Opens a space from the sidebar, where a new one appears without being opened. */
export async function openSpace(page: Page, name: string, timeoutMs: number): Promise<void> {
  await page.mouse.move(40, 500);
  const entry = page.getByText(name, { exact: true });
  await expectVisible(entry, `"${name}" in the sidebar`, 15000);
  await entry.first().click();
  await page.mouse.move(800, 20);
  await expectVisible(iconButton(page, "layout"), `The space "${name}" with its template picker`, timeoutMs);
}

export async function openTemplate(page: Page, template: string, timeoutMs: number): Promise<void> {
  await iconButton(page, "layout").first().click();
  await expectVisible(page.getByText(template, { exact: true }), `"${template}" in the template picker`, 10000);
  await page.getByText(template, { exact: true }).first().click();
  await expectVisible(button(page, "New call"), `The ${template} template's "New call"`, timeoutMs);
}

export async function startCall(page: Page, timeoutMs: number): Promise<void> {
  await button(page, "New call").first().click();
  await expectVisible(iconButton(page, "phone-x"), "The call's leave button", timeoutMs);
}

export async function transcribeState(page: Page): Promise<TranscribeState> {
  const toggle = iconButton(page, "text-aa").first();
  if (!(await visible(toggle))) return "absent";
  const variant = await toggle.getAttribute("variant");
  return variant === "danger" ? "listening" : variant === "secondary" ? "starting" : "off";
}

/**
 * Transcription on, and producing. WE starts it by itself on joining a call when a model is
 * installed; the toggle is pressed only if that did not happen — pressing it while on turns it off.
 */
export async function ensureTranscribing(page: Page, timeoutMs: number): Promise<{ pressed: boolean }> {
  await expectVisible(iconButton(page, "text-aa"), "The call bar's transcribe toggle", 30000);
  const graceEnd = Date.now() + 10000;
  while (Date.now() < graceEnd && (await transcribeState(page)) === "off") await page.waitForTimeout(500);
  const pressed = (await transcribeState(page)) === "off";
  if (pressed) await iconButton(page, "text-aa").first().click();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await transcribeState(page)) === "listening") return { pressed };
    await page.waitForTimeout(500);
  }
  throw new Error(`Transcription did not start listening within ${timeoutMs} ms (state: ${await transcribeState(page)})`);
}

export async function leaveCall(page: Page, timeoutMs: number): Promise<void> {
  await iconButton(page, "phone-x").first().click();
  await iconButton(page, "phone-x").first().waitFor({ state: "detached", timeout: timeoutMs });
}

/** Whether the text is on screen — shadow roots included. */
export async function showsText(page: Page, text: RegExp): Promise<boolean> {
  return visible(page.getByText(text));
}

/** Visible WE elements and buttons, for a failed step's diagnostics. */
export async function describeUi(page: Page): Promise<string> {
  return (await page
    .evaluate(`(() => {
      const out = [];
      const walk = (root, depth) => {
        if (depth > 12) return;
        for (const el of root.children || []) {
          const r = el.getBoundingClientRect();
          const tag = el.tagName.toLowerCase();
          if (r.width > 0 && r.height > 0 && r.y < innerHeight && (tag.startsWith('we-') || tag === 'button' || tag === 'input')) {
            const attrs = ['name', 'content', 'aria-label', 'variant', 'placeholder']
              .map((a) => (el.getAttribute(a) ? a + '=' + JSON.stringify(el.getAttribute(a)) : ''))
              .filter(Boolean).join(' ');
            const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40);
            out.push('<' + tag + (attrs ? ' ' + attrs : '') + '> ' + text + ' @' + Math.round(r.x) + ',' + Math.round(r.y));
          }
          if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
          walk(el, depth + 1);
        }
      };
      walk(document.body, 0);
      return out.slice(0, 300).join('\\n');
    })()`)
    .catch((e: Error) => `(could not read the page: ${e.message})`)) as string;
}
