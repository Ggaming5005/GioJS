import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';

export const runtime = 'edge';

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const q = request.nextUrl.searchParams.get('q');
  const auth = request.headers.get('authorization');
  return NextResponse.json({ id: params.id, q, auth });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  if (!body) return new NextResponse('bad', { status: 400 });
  return NextResponse.redirect(new URL('/done', 'https://example.com'));
}
