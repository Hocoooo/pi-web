/** Static PowerShell only: the authorized filename is passed in an environment variable. */
export const windowsRevealFallbackScript = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$p = New-Object System.Diagnostics.ProcessStartInfo
$p.FileName = Join-Path $env:SystemRoot 'explorer.exe'
$p.Arguments = '/n,/select,"' + $env:PI_WEB_DESKTOP_FILE + '"'
$p.UseShellExecute = $true
[System.Diagnostics.Process]::Start($p) | Out-Null
Write-Output 'window'
`;

/**
 * UIA invokes the actual tab button (no SendKeys or clipboard). ShellWindows
 * exposes each Windows 11 tab as a separate COM identity with the same HWND.
 * Never navigate an existing view: require one newly registered view in the
 * chosen window and an increased tab count before using Navigate2/SelectItem.
 * Unsupported Windows versions, inaccessible UIA and ambiguous views fall back.
 */
export const windowsRevealInTabScript = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Get-ViewIdentity($view) {
  $pointer = [System.Runtime.InteropServices.Marshal]::GetIUnknownForObject($view)
  try { return $pointer.ToInt64().ToString() }
  finally { [System.Runtime.InteropServices.Marshal]::Release($pointer) | Out-Null }
}
function Find-Control($root, $id) {
  $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $id)
  return $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
}
function Get-TabCount($list) {
  $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)
  return $list.FindAll([System.Windows.Automation.TreeScope]::Children, $condition).Count
}
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class PiExplorerWindows {
  [DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr window, uint command);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
}
'@
  $shell = New-Object -ComObject Shell.Application
  # Retain the old RCWs until the operation ends so their identities cannot be recycled.
  $oldViews = @($shell.Windows() | Where-Object { $_.FullName -like '*\explorer.exe' })
  $handles = @{}
  $before = @{}
  foreach ($view in $oldViews) {
    $handles[[long]$view.HWND] = $true
    $before[(Get-ViewIdentity $view)] = $true
  }
  $target = [PiExplorerWindows]::GetTopWindow([IntPtr]::Zero)
  $visited = 0
  while ($target -ne [IntPtr]::Zero -and $visited -lt 4096) {
    if ($handles.ContainsKey($target.ToInt64()) -and [PiExplorerWindows]::IsWindowVisible($target)) { break }
    $target = [PiExplorerWindows]::GetWindow($target, 2)
    $visited++
  }
  if ($target -eq [IntPtr]::Zero -or $visited -ge 4096) { throw 'No Explorer window' }
  if ([PiExplorerWindows]::IsIconic($target)) { [PiExplorerWindows]::ShowWindowAsync($target, 9) | Out-Null }
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($target)
  $tabs = Find-Control $root 'TabView'
  if ($null -eq $tabs) { throw 'Tabbed Explorer unavailable' }
  $list = Find-Control $tabs 'TabListView'
  $button = Find-Control $tabs 'AddButton'
  if ($null -eq $list -or $null -eq $button -or !$button.Current.IsEnabled) { throw 'New tab unavailable' }
  $oldCount = Get-TabCount $list
  $invoke = $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  # Foreground activation is best-effort; all actions below still target this HWND.
  [PiExplorerWindows]::SetForegroundWindow($target) | Out-Null
  $deadline = [DateTime]::UtcNow.AddSeconds(7)
  $invoke.Invoke()
  $newView = $null
  while ([DateTime]::UtcNow -lt $deadline) {
    $candidates = @($shell.Windows() | Where-Object {
      $_.FullName -like '*\explorer.exe' -and [long]$_.HWND -eq $target.ToInt64() -and !$before.ContainsKey((Get-ViewIdentity $_))
    })
    if ($candidates.Count -gt 1) { throw 'Ambiguous new Explorer tabs' }
    if ($candidates.Count -eq 1 -and (Get-TabCount $list) -eq ($oldCount + 1)) {
      $newView = $candidates[0]
      break
    }
    Start-Sleep -Milliseconds 100
  }
  if ($null -eq $newView) { throw 'New tab registration timed out' }
  $file = $env:PI_WEB_DESKTOP_FILE
  $folder = [System.IO.Path]::GetDirectoryName($file)
  $name = [System.IO.Path]::GetFileName($file)
  $newView.Navigate2($folder)
  $selected = $false
  while ([DateTime]::UtcNow -lt $deadline) {
    try {
      $document = $newView.Document
      $actual = $document.Folder.Self.Path
      if ([String]::Equals($actual.TrimEnd('\'), $folder.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
        $item = $document.Folder.ParseName($name)
        if ($null -ne $item) {
          # SELECT | DESELECTOTHERS | ENSUREVISIBLE | FOCUSED
          $document.SelectItem($item, 29)
          $items = $document.SelectedItems()
          if ($items.Count -eq 1 -and [String]::Equals($items.Item(0).Path, $file, [StringComparison]::OrdinalIgnoreCase)) {
            $selected = $true
            break
          }
        }
      }
    } catch { # A new tab's document can be temporarily unavailable during navigation.
    }
    Start-Sleep -Milliseconds 100
  }
  if (!$selected) { throw 'File selection timed out' }
  Write-Output 'tab'
} catch {
  # Never close a tab on failure: the user may already have interacted with it.
` + windowsRevealFallbackScript + String.raw`
}
`;
