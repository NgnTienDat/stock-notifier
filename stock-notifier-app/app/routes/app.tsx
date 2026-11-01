import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import {
  Outlet,
  useLoaderData,
  useRouteError,
  useNavigation,
} from "react-router";
import { useEffect } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import { getCoverage } from "../modules/dashboard/dashboard.repository.server";
import "../modules/dashboard/dashboard.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const context = await authenticate.admin(request);
  const coverage = await getCoverage(context.session.shop)
    .then((rows) => ({ coverage: rows, coverageError: null }))
    .catch(() => ({
      coverage: [],
      coverageError: "Location coverage could not be loaded. Please retry.",
    }));

  // eslint-disable-next-line no-undef
  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    ...coverage,
  };
};

export default function App() {
  const { apiKey, coverageError } = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const navigation = useNavigation();
  useEffect(() => {
    shopify.loading(navigation.state !== "idle");
    return () => shopify.loading(false);
  }, [shopify, navigation.state]);

  return (
    <AppProvider apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Dashboard</s-link>
        <s-link href="/app/alerts">Alert history</s-link>
        <s-link href="/app/settings">Settings</s-link>
      </s-app-nav>
      {coverageError && (
        <s-banner heading="Coverage unavailable" tone="critical">
          {coverageError}
        </s-banner>
      )}
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
