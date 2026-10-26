using System.Diagnostics;
using System.IO.Compression;
using System.Reflection;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace VitualXRing;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        try
        {
            Application.Run(new MainForm(WebAssets.Extract()));
        }
        catch (Exception error)
        {
            MessageBox.Show(
                $"Vitual XRing 启动失败：\r\n{error.Message}",
                "Vitual XRing",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
    }
}

internal sealed class MainForm : Form
{
    private const string VirtualHost = "vtx.local";
    private const string ApiBase = "https://xsmmc.caldson.us.ci/api";
    private readonly WebView2 _webView = new() { Dock = DockStyle.Fill };
    private readonly string _webRoot;

    public MainForm(string webRoot)
    {
        _webRoot = webRoot;
        Text = "Vitual XRing 1.8.0";
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(1280, 820);
        MinimumSize = new Size(900, 600);
        BackColor = Color.FromArgb(31, 36, 48);
        try
        {
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        }
        catch
        {
            // 取不到 EXE 图标时使用系统默认图标
        }
        Controls.Add(_webView);
        Load += async (_, _) => await InitializeAsync();
    }

    private async Task InitializeAsync()
    {
        try
        {
            var userData = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "VitualXRing",
                "WebView2");
            Directory.CreateDirectory(userData);

            var environment = await CoreWebView2Environment.CreateAsync(null, userData);
            await _webView.EnsureCoreWebView2Async(environment);
            var core = _webView.CoreWebView2;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = true;

            core.SetVirtualHostNameToFolderMapping(
                VirtualHost,
                _webRoot,
                CoreWebView2HostResourceAccessKind.Allow);

            // 页面里的 vtx-api.js 默认先请求同源的 /api；桌面版没有同源后端，
            // 这里在页面脚本执行前把 API 指向线上 Worker。
            await core.AddScriptToExecuteOnDocumentCreatedAsync(
                "try { sessionStorage.removeItem('vtxApiBase'); } catch (e) {}\r\n" +
                $"window.VTX_API_BASE = '{ApiBase}';\r\n");

            core.NewWindowRequested += OnNewWindowRequested;
            core.NavigationCompleted += OnNavigationCompleted;
            core.Navigate($"https://{VirtualHost}/index.html");
        }
        catch (WebView2RuntimeNotFoundException)
        {
            MessageBox.Show(
                this,
                "未检测到 Microsoft Edge WebView2 运行时。\r\n\r\n" +
                "请先安装 WebView2 Runtime（Windows 10/11 通常已自带）：\r\n" +
                "https://developer.microsoft.com/microsoft-edge/webview2/",
                "Vitual XRing",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            Close();
        }
        catch (Exception error)
        {
            MessageBox.Show(
                this,
                $"加载桌面版页面失败：\r\n{error.Message}",
                "Vitual XRing",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            Close();
        }
    }

    private void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs args)
    {
        if (!args.IsSuccess)
        {
            Text = $"Vitual XRing 1.8.0（页面加载失败：{args.WebErrorStatus}）";
        }
    }

    private void OnNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs args)
    {
        args.Handled = true;
        if (string.IsNullOrWhiteSpace(args.Uri))
        {
            return;
        }
        try
        {
            Process.Start(new ProcessStartInfo(args.Uri) { UseShellExecute = true });
        }
        catch
        {
            // 打不开外部浏览器时不打断应用
        }
    }
}

internal static class WebAssets
{
    public static string Extract()
    {
        var root = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "VitualXRing",
            "web");
        var fullRoot = Path.GetFullPath(root);

        if (Directory.Exists(fullRoot))
        {
            try
            {
                Directory.Delete(fullRoot, true);
            }
            catch
            {
                // 文件被占用时保留旧目录，下面按文件覆盖
            }
        }
        Directory.CreateDirectory(fullRoot);

        using var stream = Assembly.GetExecutingAssembly()
            .GetManifestResourceStream("VitualXRing.web.zip")
            ?? throw new InvalidOperationException("内置网页资源缺失（web.zip 未打包进 EXE）");
        using var archive = new ZipArchive(stream, ZipArchiveMode.Read);
        foreach (var entry in archive.Entries)
        {
            if (string.IsNullOrEmpty(entry.Name))
            {
                Directory.CreateDirectory(Path.Combine(fullRoot, entry.FullName));
                continue;
            }
            var target = Path.GetFullPath(Path.Combine(fullRoot, entry.FullName));
            if (!target.StartsWith(fullRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            entry.ExtractToFile(target, true);
        }
        return fullRoot;
    }
}
