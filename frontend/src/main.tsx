import React from "react";
import { createRoot } from "react-dom/client";
import "./styles/terminal.css";
import { App } from "./App";

document.body.classList.add("crt");
createRoot(document.getElementById("root")!).render(<App />);
