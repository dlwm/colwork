export function colorWithAlpha(color: string, alpha: number) {
  const value = color.trim().replace('#', '')
  if (/^[\da-f]{3}$/i.test(value)) {
    const [r, g, b] = value.split('').map((part) => Number.parseInt(part + part, 16))
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }
  if (/^[\da-f]{6}$/i.test(value)) {
    const rgb = Number.parseInt(value, 16)
    return `rgba(${rgb >> 16}, ${(rgb >> 8) & 255}, ${rgb & 255}, ${alpha})`
  }
  const rgb = color.match(/^rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)/i)
  if (rgb) return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${alpha})`
  return `color-mix(in srgb, ${color} 12%, transparent)`
}
