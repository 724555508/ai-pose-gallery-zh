import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ImagePlusIcon, LoaderCircleIcon, UploadIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { toast } from '@/lib/notifications'
import { costumesQuery } from '@/api/gallery'
import type { CostumeItem } from '@/types/gallery'

export function UploadCostume({ onSaved }: { onSaved: (item: CostumeItem) => void }) {
  const [open, setOpen] = useState(false)
  const [image, setImage] = useState('')
  const [name, setName] = useState('')
  const [category, setCategory] = useState('自定义穿搭')
  const [kind, setKind] = useState('现实')
  const [tags, setTags] = useState('')
  const [keywords, setKeywords] = useState('')
  const [sensitive, setSensitive] = useState(false)
  const [busy, setBusy] = useState(false)
  const [reading, setReading] = useState(false)
  const lock = useRef(false)
  const client = useQueryClient()
  const choose = async (file?: File) => {
    if (!file) return
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 20 * 1024 * 1024) { toast.error('请选择 20 MB 以内的 PNG、JPEG 或 WebP 图片'); return }
    setReading(true)
    try {
      const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('图片读取失败')); reader.readAsDataURL(file) })
      setImage(data)
      if (!name) setName(file.name.replace(/\.[^.]+$/, '').slice(0, 120))
    } catch { toast.error('图片读取失败，请重新选择') } finally { setReading(false) }
  }
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (lock.current || reading) return
    if (!image) { toast.error('请先选择服装图片'); return }
    lock.current = true; setBusy(true)
    try {
      const response = await fetch('/api/local-costumes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image, name, category, kind, sensitive, keywords, tags: tags.split(/[,，、\n]/).map((tag) => tag.trim()).filter(Boolean) }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || '上传失败')
      const item = result as CostumeItem
      client.setQueryData(costumesQuery.queryKey, (old: CostumeItem[] | undefined) => [item, ...(old || []).filter((entry) => entry.id !== item.id)])
      onSaved(item)
      setOpen(false); setImage(''); setName(''); setTags(''); setKeywords(''); setSensitive(false)
      toast.success(item.敏感 ? '已保存，安全模式下会隐藏此服装' : '穿搭已加入图库，可以直接加入配方')
    } catch (error) { toast.error(error instanceof Error ? error.message : '上传失败，请刷新图库确认是否已保存') }
    finally { lock.current = false; setBusy(false) }
  }
  return <>
    <Button onClick={() => setOpen(true)}><UploadIcon className="size-4" />上传穿搭</Button>
    <Dialog open={open} onOpenChange={(value) => { if (!busy && !reading) setOpen(value) }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader><DialogTitle>上传服装穿搭</DialogTitle><DialogDescription>保存到当前服务器，其他机器刷新服装库后也能使用。</DialogDescription></DialogHeader>
        <form onSubmit={(event) => void submit(event)} className="space-y-4">
          <label className="relative flex min-h-40 cursor-pointer flex-col items-center justify-center gap-2 overflow-hidden rounded-2xl border-2 border-dashed bg-muted/40 p-4 transition hover:bg-muted/70 focus-within:ring-2 focus-within:ring-ring">
            {image ? <img src={image} alt="待上传的服装" className="max-h-52 object-contain" /> : <ImagePlusIcon className="size-8 text-muted-foreground" />}
            <span className="text-xs text-muted-foreground">{reading ? '正在读取图片…' : image ? '点击更换图片' : '点击选择服装图片 · PNG / JPEG / WebP · 最大 20 MB'}</span>
            <input aria-label="选择服装图片" className="absolute inset-0 cursor-pointer opacity-0" type="file" accept="image/png,image/jpeg,image/webp" disabled={busy || reading} onChange={(event) => { void choose(event.target.files?.[0]); event.target.value = '' }} />
          </label>
          <fieldset disabled={busy || reading} className="space-y-4">
            <label className="grid gap-2 text-xs font-medium">穿搭名称<Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：米白针织衫・棕色百褶裙・短靴" required maxLength={120} /></label>
            <div className="grid grid-cols-2 gap-3">
              <label className="grid gap-2 text-xs font-medium">类型<select className="h-9 rounded-md border bg-background px-2 text-sm" value={kind} onChange={(e) => setKind(e.target.value)}><option>现实</option><option>二次元</option></select></label>
              <label className="grid gap-2 text-xs font-medium">分类<Input list="upload-costume-categories" value={category} onChange={(e) => setCategory(e.target.value)} required maxLength={40} /><datalist id="upload-costume-categories">{['自定义穿搭', '春季穿搭', '夏季穿搭', '秋季穿搭', '冬季穿搭', '派对・礼服', '泳装・度假', '内衣・睡衣', '性感穿搭'].map((value) => <option key={value} value={value} />)}</datalist></label>
            </div>
            <label className="grid gap-2 text-xs font-medium">标签<span className="font-normal text-muted-foreground">使用逗号分隔，方便筛选与搜索</span><Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="米白色，针织，长袖，百褶裙" maxLength={1000} /></label>
            <label className="grid gap-2 text-xs font-medium">英文关键词（可选）<Input value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="ivory knit sweater, brown pleated skirt" maxLength={1000} /></label>
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={sensitive} onChange={(e) => setSensitive(e.target.checked)} />标记为敏感服装（安全模式下隐藏）</label>
          </fieldset>
          <div className="flex justify-end gap-2 border-t pt-4"><Button type="button" variant="outline" disabled={busy || reading} onClick={() => setOpen(false)}>取消</Button><Button type="submit" disabled={busy || reading || !image || !name.trim() || !category.trim()}>{busy ? <LoaderCircleIcon className="size-4 animate-spin" /> : <UploadIcon className="size-4" />}{busy ? '正在保存…' : '保存到服装库'}</Button></div>
        </form>
      </DialogContent>
    </Dialog>
  </>
}
