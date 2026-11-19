import { Workspace } from "@/components/workspace/workspace"

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <Workspace sessionId={id} />
}
