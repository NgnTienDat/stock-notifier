import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  data,
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  useRevalidator,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { createShopifyGraphqlService } from "../modules/shopify/graphql/shopify-graphql.server";
import { getLocationSettings } from "../modules/settings/settings.repository.server";
import {
  InvalidLocationError,
  selectLocation,
} from "../modules/settings/settings.service.server";
import { LocationSelection } from "../modules/settings/location-selection";
import type { LocationData } from "../modules/shopify/graphql/types";

function preserveAuthenticationResponse(error: unknown) {
  if (
    error instanceof Response &&
    (error.status === 401 || (error.status >= 300 && error.status < 400))
  )
    throw error;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const context = await authenticate.admin(request);
  const selected = await getLocationSettings(context.session.shop);
  try {
    const locations = await createShopifyGraphqlService(context).getLocations();
    return {
      selected,
      locations,
      error: null,
    };
  } catch (error) {
    preserveAuthenticationResponse(error);
    return {
      selected,
      locations: [] as LocationData[],
      error: "Could not load locations from Shopify. Please try again.",
    };
  }
}

export async function action({ request }: ActionFunctionArgs) {
  const context = await authenticate.admin(request);
  const form = await request.formData();
  const values = form.getAll("locationGid");
  const locationGid = values[0];
  if (
    values.length !== 1 ||
    typeof locationGid !== "string" ||
    !locationGid.trim()
  ) {
    return data(
      { saved: false, error: "Choose one location." },
      { status: 400 },
    );
  }
  try {
    await selectLocation(context, locationGid);
    return data({ saved: true, error: null });
  } catch (error) {
    preserveAuthenticationResponse(error);
    if (error instanceof InvalidLocationError)
      return data({ saved: false, error: error.message }, { status: 400 });
    return data(
      { saved: false, error: "Could not save location. Please try again." },
      { status: 503 },
    );
  }
}

export default function Settings() {
  const { selected, locations, error } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const busy = navigation.state !== "idle" || revalidator.state !== "idle";

  return (
    <s-page heading="StockPulse settings">
      <Form method="post">
        <LocationSelection
          key={`${selected?.locationGid ?? "unselected"}:${locations.length > 0}`}
          selected={selected}
          locations={locations}
          error={error ?? result?.error ?? null}
          saved={result?.saved ?? false}
          busy={busy}
          onRetry={() => revalidator.revalidate()}
        />
      </Form>
    </s-page>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);
