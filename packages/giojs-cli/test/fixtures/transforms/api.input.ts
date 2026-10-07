import type { NextApiRequest, NextApiResponse } from 'next';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'POST') {
    res.status(201).json({ created: req.body.name });
    return;
  }
  res.status(200).json({ name: 'John Doe' });
}

export const config = { api: { bodyParser: false } };
