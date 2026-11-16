import win32com.client
import os

TEMP_FOLDER = r"C:\TempBunker"

outlook = win32com.client.Dispatch("Outlook.Application")
namespace = outlook.GetNamespace("MAPI")

inbox = namespace.GetDefaultFolder(6)

messages = inbox.Items
messages.Sort("[ReceivedTime]", True)

saved = False

for message in messages:

    try:

        if "Fortnightly" in str(message.Subject):

            if message.Attachments.Count > 0:

                print("Email Found:")
                print(message.Subject)

                attachment = message.Attachments.Item(1)

                save_path = os.path.join(
                    TEMP_FOLDER,
                    attachment.FileName
                )

                attachment.SaveAsFile(save_path)

                print("\nDownloaded Successfully:")
                print(save_path)

                saved = True
                break

    except Exception as e:

        print("ERROR:", e)

if not saved:

    print("No suitable bunker attachment found.")
