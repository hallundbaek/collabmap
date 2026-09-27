import React from "react";
import Builder from "./Builder.jsx";
import AreaPage from "./AreaPage.jsx";

function Home() {
  return (
    <div style={{ display: "flex", height: "100%", alignItems: "center", justifyContent: "center", textAlign: "center" }}>
      <div>
        <h2 style={{ margin: "0 0 6px" }}>CollabMap</h2>
        <p className="hint">Open an area link to record routes, or use your admin link (<code>/admin/&lt;token&gt;</code>).</p>
      </div>
    </div>
  );
}

export default function App() {
  const path = window.location.pathname;

  const areaMatch = path.match(/^\/area\/([a-f0-9]+)\/([a-f0-9]+)/);
  if (areaMatch) return <AreaPage areaToken={areaMatch[1]} campaignToken={areaMatch[2]} />;

  const adminMatch = path.match(/^\/admin\/([A-Za-z0-9]+)/);
  if (adminMatch) return <Builder token={adminMatch[1]} />;

  return <Home />;
}