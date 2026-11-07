export async function backupGeneratedImage(imageUrl: string): Promise<void> {
  if (!import.meta.env.VITE_LOCAL_IMAGE_BACKUP) return
  const image = await fetch(imageUrl)
  if (!image.ok) throw new Error('无法读取生成图片')
  const blob = await image.blob()
  const response = await fetch('/api/local-image-backup', {
    method: 'POST',
    headers: { 'Content-Type': blob.type },
    body: blob,
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) {
    const detail = await response.json().catch(() => null)
    throw new Error(detail?.error || `本地备份失败（${response.status}）`)
  }
}
