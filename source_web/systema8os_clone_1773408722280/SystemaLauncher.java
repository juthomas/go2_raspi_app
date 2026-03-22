
import java.awt.Desktop;
import java.io.File;
import java.io.IOException;
import java.net.URI;

public class SystemaLauncher {
    public static void main(String[] args) {
        try {
            File htmlFile = new File("index.html");
            if (htmlFile.exists()) {
                Desktop.getDesktop().browse(htmlFile.toURI());
                System.out.println("Launching Systema8os.xt in default browser...");
            } else {
                System.err.println("Error: index.html not found in current directory.");
            }
        } catch (IOException e) {
            e.printStackTrace();
        }
    }
}
