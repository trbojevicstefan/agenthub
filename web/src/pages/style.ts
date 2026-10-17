// The stylesheet of the account pages, served as /assets/site.css. The colors follow the desktop app (ui/style.css).
export const SITE_CSS = `
:root{--bg:#111315;--panel:#17191c;--surface:#1b1e21;--border:#2b2f32;--muted:#91999f;--text:#e8eced;--accent:#b5f5cf;--accent-text:#143425;--danger:#f7a59c;--danger-bg:#3a1f1c;--ok-bg:#183728;--radius:12px;
  --font:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:dark}
@media (prefers-color-scheme:light){:root{--bg:#f5f6f7;--panel:#fff;--surface:#f0f2f3;--border:#dde1e3;--muted:#5d666c;--text:#16191b;--accent:#1f7a4f;--accent-text:#fff;--danger:#b3261e;--danger-bg:#fde8e6;--ok-bg:#e3f5ea;color-scheme:light}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 var(--font);-webkit-font-smoothing:antialiased;min-height:100vh;display:flex;flex-direction:column}
a{color:var(--accent)}a:hover{text-decoration:none}
h1{font-size:28px;line-height:1.2;font-weight:600;letter-spacing:-.6px;margin:0 0 16px}h1+p{margin-top:-8px;margin-bottom:20px}h2{font-size:18px;font-weight:600;margin:0 0 12px}h3{font-size:15px;margin:0 0 6px}
p{margin:0 0 12px}.muted{color:var(--muted)}small{font-size:13px}
.top{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 24px;border-bottom:1px solid var(--border)}
.brand{display:flex;align-items:center;gap:10px;color:var(--text);text-decoration:none;font-weight:650;font-size:17px}.brand img{width:28px;height:28px;border-radius:7px}
nav{display:flex;align-items:center;gap:18px;flex-wrap:wrap}nav a{color:var(--muted);text-decoration:none}nav a:hover,nav a[aria-current]{color:var(--text)}nav form{margin:0}
main{width:100%;max-width:980px;margin:0 auto;padding:40px 24px 64px;flex:1}
main.narrow{max-width:460px}
footer{padding:20px 24px;color:var(--muted);font-size:13px;text-align:center;border-top:1px solid var(--border)}footer a{color:var(--muted)}
.card{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);padding:24px;margin:0 0 20px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:20px}
label{display:block;font-weight:550;margin:0 0 6px}
.field{margin:0 0 16px}.card .field{max-width:460px}.field small{display:block;color:var(--muted);margin-top:6px}
input[type=text],input[type=email],input[type=password],input:not([type]){width:100%;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:11px 12px;font:inherit}
input:focus{outline:2px solid var(--accent);outline-offset:1px}
input.code{font:600 22px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:4px;text-align:center;text-transform:uppercase}
button,.button{display:inline-flex;align-items:center;justify-content:center;gap:8px;border:1px solid var(--border);background:var(--surface);color:var(--text);border-radius:8px;padding:10px 16px;font:inherit;font-weight:600;cursor:pointer;text-decoration:none}
button:hover,.button:hover{border-color:var(--muted)}
.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-text)}.primary:hover{filter:brightness(1.06);border-color:var(--accent)}
.danger{color:var(--danger);border-color:var(--danger)}
.link{background:none;border:0;padding:0;color:var(--muted);font-weight:400}.link:hover{color:var(--text)}
.wide{width:100%}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.social form{margin:0 0 10px}.stack>*+*{margin-top:12px}.right{text-align:right}.mt{margin-top:16px}
.or{display:flex;align-items:center;gap:12px;color:var(--muted);margin:18px 0;font-size:13px}.or:before,.or:after{content:"";flex:1;border-top:1px solid var(--border)}
.notice{border-radius:8px;padding:12px 14px;margin:0 0 18px;background:var(--surface);border:1px solid var(--border)}
.notice.error{background:var(--danger-bg);border-color:var(--danger);color:var(--danger)}.notice.ok{background:var(--ok-bg);border-color:var(--accent)}
.plan h2{margin-bottom:4px}.price{font-size:32px;font-weight:650;letter-spacing:-1px;margin:10px 0 2px}.price span{font-size:15px;font-weight:400;color:var(--muted)}
.plan ul{padding-left:18px;margin:14px 0 18px}.plan li{margin:4px 0}.plan.current{border-color:var(--accent)}
.badge{display:inline-block;font-size:12px;font-weight:650;padding:2px 8px;border-radius:999px;background:var(--ok-bg);color:var(--accent);border:1px solid var(--accent);vertical-align:middle}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:10px 8px;border-bottom:1px solid var(--border);vertical-align:top}th{color:var(--muted);font-weight:500;font-size:13px}
dl{display:grid;grid-template-columns:max-content 1fr;gap:8px 20px;margin:0}dt{color:var(--muted)}dd{margin:0}
.qr{background:#fff;padding:12px;border-radius:8px;width:220px;height:220px}.qr svg{width:100%;height:100%}
.codes{font:14px/1.8 ui-monospace,SFMono-Regular,Menlo,monospace;columns:2;background:var(--surface);border-radius:8px;padding:12px 16px;margin:0 0 16px}
.user-code{font:650 30px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:5px;text-align:center;padding:16px;background:var(--surface);border-radius:8px;margin:0 0 18px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;background:var(--surface);padding:2px 6px;border-radius:5px;overflow-wrap:anywhere}
@media (max-width:600px){.top{padding:12px 16px}main{padding:28px 16px 48px}.card{padding:18px}}
`;
