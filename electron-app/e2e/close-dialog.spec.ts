import { test, expect } from "./fixtures";

test.describe("Close Confirmation Dialog", () => {
  test("shows confirmation when closing running tab", async ({ mockedPage: page }) => {
    await page.route("**/sandbox/list", (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{
          id: "sb-1",
          kind: { type: "cli", detail: { command: "zsh", args: [] } },
          status: { type: "Running" },
          pty_pid: 100,
          port: 15801,
        }]),
      });
    });

    await page.goto("/");
    await expect(page.locator(".tab-item")).toHaveCount(1, { timeout: 10000 });

    // Click close button on tab
    await page.locator(".tab-close").click();

    // Confirmation dialog should appear
    await expect(page.locator(".dialog-title")).toHaveText("Close Terminal");
    await expect(page.locator(".dialog-message")).toContainText("still running");
  });

  test("cancel dismisses dialog without closing", async ({ mockedPage: page }) => {
    await page.route("**/sandbox/list", (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{
          id: "sb-1",
          kind: { type: "cli", detail: { command: "zsh", args: [] } },
          status: { type: "Running" },
          pty_pid: 100,
          port: 15801,
        }]),
      });
    });

    await page.goto("/");
    await expect(page.locator(".tab-item")).toHaveCount(1, { timeout: 10000 });

    await page.locator(".tab-close").click();
    await expect(page.locator(".dialog-title")).toHaveText("Close Terminal");

    // Click Cancel
    await page.getByRole("button", { name: "Cancel" }).click();

    // Dialog should be gone, tab should still be there
    await expect(page.locator(".dialog-title")).not.toBeVisible();
    await expect(page.locator(".tab-item")).toHaveCount(1);
  });

  test("close button actually removes tab", async ({ mockedPage: page }) => {
    let closed = false;

    // Use a dynamic mock: after DELETE, sandbox/list returns empty
    await page.route("**/sandbox/list", (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: closed
          ? JSON.stringify([])
          : JSON.stringify([{
              id: "sb-1",
              kind: { type: "cli", detail: { command: "zsh", args: [] } },
              status: { type: "Running" },
              pty_pid: 100,
              port: 15801,
            }]),
      });
    });

    // Mock DELETE endpoint
    await page.route("**/sandbox/sb-1", (route) => {
      if (route.request().method() === "DELETE") {
        closed = true;
        route.fulfill({ status: 200 });
      } else {
        route.continue();
      }
    });

    await page.goto("/");
    await expect(page.locator(".tab-item")).toHaveCount(1, { timeout: 10000 });

    await page.locator(".tab-close").click();
    await expect(page.locator(".dialog-title")).toHaveText("Close Terminal");

    // Click Close in dialog
    await page.getByRole("button", { name: "Close" }).click();

    // Tab should be removed, empty state shown
    // The polling runs every 3s, so the mock will return empty on next poll
    await expect(page.locator(".empty-state-text")).toHaveText("No sandbox open", { timeout: 10000 });
  });
});
