Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

$window = New-Object System.Windows.Window
$window.Title = 'Prompt Optimizer Hotkey Harness'
$window.Width = 760
$window.Height = 300
$window.WindowStartupLocation = 'CenterScreen'
$window.Topmost = $true

$textBox = New-Object System.Windows.Controls.TextBox
$textBox.AcceptsReturn = $true
$textBox.AcceptsTab = $true
$textBox.TextWrapping = 'Wrap'
$textBox.VerticalScrollBarVisibility = 'Auto'
$textBox.FontFamily = 'Segoe UI'
$textBox.FontSize = 16
$textBox.Padding = '16'
$textBox.Text = 'Use the above architecture and make the context-aware function understand what I am building.'
$window.Content = $textBox

$window.Add_Loaded({
  $textBox.Focus() | Out-Null
  $textBox.CaretIndex = $textBox.Text.Length
})

[void]$window.ShowDialog()
