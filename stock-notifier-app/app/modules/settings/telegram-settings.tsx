import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import type { action } from "../../routes/app.settings.telegram";

export function TelegramSettings({
  chatId,
  botConfigured,
  busy,
}: {
  chatId: string | null;
  botConfigured: boolean;
  busy: boolean;
}) {
  const [value, setValue] = useState(chatId ?? "");
  useEffect(() => setValue(chatId ?? ""), [chatId]);
  const save = useFetcher<typeof action>();
  const test = useFetcher<typeof action>();
  const working = save.state !== "idle" || test.state !== "idle";
  return (
    <s-section heading="Telegram notifications">
      <s-stack direction="block" gap="base">
        <s-paragraph>
          Open your bot in Telegram and press Start before sending a test. For a
          group, add the bot first. Save the numeric Chat ID, including the
          minus sign for groups.
        </s-paragraph>
        {(!botConfigured || !chatId) && (
          <s-banner heading="Telegram configuration incomplete" tone="warning">
            {!botConfigured
              ? "Configure TELEGRAM_BOT_TOKEN on the server and restart the app and worker. "
              : ""}
            {!chatId ? "Save your Telegram Chat ID. " : ""}Inventory sync and
            webhooks continue to work.
          </s-banner>
        )}
        <save.Form method="post" action="/app/settings/telegram">
          <input type="hidden" name="intent" value="save" />
          <s-stack direction="block" gap="base">
            <label htmlFor="telegramChatId">Telegram Chat ID</label>
            <input
              id="telegramChatId"
              name="telegramChatId"
              type="text"
              maxLength={17}
              value={value}
              disabled={busy || working}
              onChange={(event) => setValue(event.target.value)}
            />
            <s-paragraph>
              Leave blank to disable future notifications. Existing historical
              alerts are not sent when you configure Telegram.
            </s-paragraph>
            <s-button
              type="submit"
              variant="primary"
              loading={save.state !== "idle" || undefined}
              disabled={busy || working || undefined}
            >
              Save Chat ID
            </s-button>
          </s-stack>
        </save.Form>
        <test.Form method="post" action="/app/settings/telegram">
          <input type="hidden" name="intent" value="test" />
          <s-button
            type="submit"
            loading={test.state !== "idle" || undefined}
            disabled={
              busy ||
              working ||
              !botConfigured ||
              !chatId ||
              value !== chatId ||
              undefined
            }
          >
            Send test message
          </s-button>
        </test.Form>
        {!working &&
          [save.data, test.data].map(
            (result, index) =>
              result && (
                <s-banner
                  key={index}
                  heading={
                    result.error
                      ? "Telegram request failed"
                      : "Telegram updated"
                  }
                  tone={result.error ? "critical" : "success"}
                >
                  {result.error ?? result.message}
                </s-banner>
              ),
          )}
        <s-paragraph>
          Automatic delivery requires the local Telegram worker to be running.
          Send test message sends one request immediately.
        </s-paragraph>
      </s-stack>
    </s-section>
  );
}
