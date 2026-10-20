import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createHttpAinOneApi } from "./api.js";
import { App } from "./app.js";
import "./styles.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("#root element not found");
}

const apiUrl =
  document.querySelector<HTMLMetaElement>('meta[name="ain-one-api"]')?.content ??
  window.localStorage.getItem("ain-one:api-url") ??
  "";

const token =
  document.querySelector<HTMLMetaElement>('meta[name="ain-one-token"]')?.content ??
  window.localStorage.getItem("ain-one:token") ??
  "";

const api = createHttpAinOneApi({
  baseUrl: apiUrl,
  token,
});

createRoot(rootElement).render(
  <StrictMode>
    <App api={api} />
  </StrictMode>,
);
