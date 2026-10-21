param([string]$OutDir = "$PSScriptRoot\icons")
Add-Type -AssemblyName System.Drawing

$targetDir = [System.IO.Path]::GetFullPath($OutDir)
if (-not (Test-Path $targetDir)) {
    New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
}

foreach ($size in 16, 32, 48, 128) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::FromArgb(255, 11, 15, 25))

    $brushGreen = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 29, 185, 84))
    $penGray = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 138, 147, 166), ([Math]::Max(1, [int]($size / 16))))

    $mw = [int]($size * 0.26)
    $mh = [int]($size * 0.42)
    $mx = [int](($size - $mw) / 2)
    $my = [int]($size * 0.14)
    $g.FillRectangle($brushGreen, $mx, $my, $mw, $mh)
    $g.DrawArc($penGray, $mx - 3, $my - 2, $mw + 6, $mh + 6, 200, 320)

    $slashPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 248, 113, 113), ([Math]::Max(2, [int]($size / 10))))
    $g.DrawLine($slashPen, [int]($size * 0.2), [int]($size * 0.8), [int]($size * 0.8), [int]($size * 0.2))

    $g.Dispose()
    $savePath = [System.IO.Path]::Combine($targetDir, "icon$size.png")
    $bmp.Save($savePath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "icon$size.png saved to $savePath"
}
