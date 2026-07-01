"use client";

import { useState } from "@ferrite/runtime";

type Props = {
  id: string;
};

export default function PostActions({ id }: Props) {
  const [likes, setLikes] = useState(0);

  return (
    <button type="button" data-client-island="post-actions" onClick={() => setLikes(likes + 1)}>
      Like {id}: {likes}
    </button>
  );
}
