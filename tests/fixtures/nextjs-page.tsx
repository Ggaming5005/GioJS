'use client';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Inter } from 'next/font/google';
import React from 'react';

const inter = Inter({ subsets: ['latin'] });

interface PostProps {
  post: { id: string; title: string; imageUrl: string };
}

export default function PostCard({ post }: PostProps): React.JSX.Element {
  const router = useRouter();

  return (
    <article className={inter.className}>
      <Image
        src={post.imageUrl}
        width={800}
        height={450}
        alt={post.title}
        priority
      />
      <h2>{post.title}</h2>
      <Link href={`/posts/${post.id}`}>
        Read more
      </Link>
      <Link href="/" prefetch={false}>
        Home
      </Link>
      <button onClick={() => router.push('/')}>Back</button>
    </article>
  );
}
