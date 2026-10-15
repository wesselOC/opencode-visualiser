// Runs before any test module loads: use a random high port (never the default 5173, which a live
// visualizer may own) and make sure the server never launches a browser.
process.env.OCV_PORT = String(20000 + Math.floor(Math.random() * 20000))
process.env.OCV_NO_BROWSER = "1"
