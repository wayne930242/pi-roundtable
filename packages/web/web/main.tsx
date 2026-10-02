import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("the page has no #root");
createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
