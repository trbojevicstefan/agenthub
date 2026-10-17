import type { FC } from "hono/jsx";
import { Errors, Field, Layout, Notice, type Viewer } from "./layout.js";

export const formatCode = (code: string) => (code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code);

export const DeviceCodePage: FC<{ viewer: Viewer; error?: string; code?: string }> = ({ viewer, error, code }) => (
  <Layout title="Connect the desktop app" viewer={viewer} narrow>
    <h1>Connect the desktop app</h1>
    <p class="muted">Type the code that the Opaya desktop app shows.</p>
    <div class="card">
      <Errors error={error} />
      <form method="get" action="/device">
        <Field label="Code" name="user_code" class="code" autocomplete="off" required maxlength={12} value={code} autofocus />
        <button class="primary wide" type="submit">
          Continue
        </button>
      </form>
    </div>
  </Layout>
);

export const DeviceApprovePage: FC<{ viewer: Viewer; code: string; deviceName: string }> = ({ viewer, code, deviceName }) => (
  <Layout title="Connect the desktop app" viewer={viewer} narrow>
    <h1>Connect {deviceName}?</h1>
    <div class="card">
      <p>Check that the desktop app shows this code:</p>
      <div class="user-code">{formatCode(code)}</div>
      <dl>
        <dt>Computer</dt>
        <dd>{deviceName}</dd>
        <dt>Account</dt>
        <dd>{viewer.email}</dd>
      </dl>
      <p class="mt muted">The desktop app gets your plan and its limits. It cannot change your account, your plan or your billing.</p>
      <div class="row mt">
        <form method="post" action="/device">
          <input type="hidden" name="user_code" value={code} />
          <input type="hidden" name="action" value="approve" />
          <button class="primary" type="submit">
            Approve
          </button>
        </form>
        <form method="post" action="/device">
          <input type="hidden" name="user_code" value={code} />
          <input type="hidden" name="action" value="deny" />
          <button type="submit">Deny</button>
        </form>
      </div>
      <p class="mt muted">
        <small>If you did not start this in the Opaya desktop app, click Deny.</small>
      </p>
    </div>
  </Layout>
);

export const DeviceDonePage: FC<{ viewer: Viewer; approved: boolean; deviceName: string }> = ({ viewer, approved, deviceName }) => (
  <Layout title={approved ? "Desktop app connected" : "Desktop app not connected"} viewer={viewer} narrow>
    <h1>{approved ? "The desktop app is connected" : "The desktop app is not connected"}</h1>
    <div class="card">
      {approved ? (
        <Notice kind="ok">{`${deviceName} is signed in as ${viewer.email}. Go back to the Opaya desktop app. You can close this tab.`}</Notice>
      ) : (
        <Notice>{`You denied the request from ${deviceName}. Nothing changed.`}</Notice>
      )}
      <p class="muted">
        To sign a computer out later, open <a href="/account#devices">Account</a>.
      </p>
    </div>
  </Layout>
);
