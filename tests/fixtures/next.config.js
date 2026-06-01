/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'cdn.example.com',
        pathname: '/images/**',
      },
      {
        protocol: 'https',
        hostname: '**.cloudinary.com',
      },
    ],
  },
  redirects: async () => [
    {
      source: '/old-blog/:slug',
      destination: '/blog/:slug',
      permanent: true,
    },
    {
      source: '/docs',
      destination: '/documentation',
      permanent: false,
    },
  ],
  rewrites: async () => [
    {
      source: '/api/:path*',
      destination: 'http://internal-service:8080/:path*',
    },
  ],
};

module.exports = nextConfig;
