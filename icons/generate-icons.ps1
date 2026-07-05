# Generates the LT app icons (192, 512, and maskable 512) using built-in Windows drawing (GDI+).
# No external software required.

Add-Type -AssemblyName System.Drawing

$outDir = "C:\LT\app\icons"
New-Item -ItemType Directory -Force $outDir | Out-Null

$specs = @(
    @{ Size = 192; File = 'icon-192.png';          Pad = 0.0  },
    @{ Size = 512; File = 'icon-512.png';          Pad = 0.0  },
    @{ Size = 512; File = 'icon-maskable-512.png'; Pad = 0.18 }
)

foreach ($spec in $specs) {
    $s = $spec.Size

    $bmp = New-Object System.Drawing.Bitmap($s, $s)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.TextRenderingHint = 'AntiAliasGridFit'

    # Dark background matching the app theme
    $g.Clear([System.Drawing.ColorTranslator]::FromHtml('#0b0f14'))

    # "LT" text, centered, in the app accent blue
    $inner = $s * (1 - 2 * $spec.Pad)
    $fontSize = [int]($inner * 0.42)
    $font = New-Object System.Drawing.Font('Segoe UI', $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $brush = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#37b6ff'))

    $fmt = New-Object System.Drawing.StringFormat
    $fmt.Alignment = 'Center'
    $fmt.LineAlignment = 'Center'

    $rect = New-Object System.Drawing.RectangleF(0, 0, $s, $s)
    $g.DrawString('LT', $font, $brush, $rect, $fmt)

    # Thin square frame around the text
    $penWidth = [Math]::Max(2, $s * 0.015)
    $pen = New-Object System.Drawing.Pen([System.Drawing.ColorTranslator]::FromHtml('#37b6ff'), $penWidth)
    $m = $s * ($spec.Pad + 0.10)
    $g.DrawRectangle($pen, $m, $m, $s - 2 * $m, $s - 2 * $m)

    $g.Dispose()
    $bmp.Save((Join-Path $outDir $spec.File), [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()

    Write-Output ("Created " + $spec.File)
}
