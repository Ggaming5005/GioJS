import React from 'react';
import type { GioErrorProps } from '@gio.js/core';

export default function ErrorPage({ error }: GioErrorProps) {
  return <h1>TESTING_KIT_ERROR {error.digest}</h1>;
}
