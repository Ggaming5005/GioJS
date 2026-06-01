export const dynamic = 'force-dynamic';

interface Params {
  id: string;
}

export default function PostPage({ params }: { params: Params }) {
  const { id } = params;
  return (
    <article>
      <h1>Post {id}</h1>
      <p>
        Lorem ipsum dolor sit amet, consectetur adipiscing elit. Quisque accumsan
        lorem at diam dignissim, vel blandit enim malesuada. Post id: {id}.
      </p>
      <p>
        Pellentesque habitant morbi tristique senectus et netus et malesuada fames
        ac turpis egestas. Curabitur varius odio vel nulla tincidunt, a fermentum
        sapien tincidunt.
      </p>
    </article>
  );
}
