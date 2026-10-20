/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // nodemailer reaches for node built-ins, so it must stay outside the bundle
  serverExternalPackages: ["nodemailer"],
  webpack: (config, { nextRuntime, webpack }) => {
    // the edge compiler also builds the instrumentation entry, and those jobs only
    // ever run inside the node server: let node: imports resolve to nothing there
    if (nextRuntime === "edge" && webpack) {
      config.plugins.push(new webpack.IgnorePlugin({ resourceRegExp: /^node:/ }));
    }
    return config;
  },
};

export default nextConfig;
