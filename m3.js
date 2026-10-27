// A CDN bundles each entry file separately, so importing several component files
// registers shared elements (md-elevation, md-ripple…) twice and aborts the load.
// The single all.js entry registers every element exactly once.
import "@material/web/all.js";
