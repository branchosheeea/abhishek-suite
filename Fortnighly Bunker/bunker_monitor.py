import win32com.client

outlook = win32com.client.Dispatch("Outlook.Application")
namespace = outlook.GetNamespace("MAPI")

inbox = namespace.GetDefaultFolder(6)

messages = inbox.Items
messages.Sort("[ReceivedTime]", True)

print("\nFORTNIGHTLY BUNKER REPORT CHECK\n")

found = 0

for message in messages:

    try:

        subject = str(message.Subject)

        if "Fortnightly" in subject:

            print("=" * 60)
            print("SUBJECT :", message.Subject)
            print("RECEIVED:", message.ReceivedTime)

            if message.Attachments.Count > 0:

                print("ATTACHMENTS:")

                for i in range(1, message.Attachments.Count + 1):

                    attachment = message.Attachments.Item(i)

                    print("  -", attachment.FileName)

            else:

                print("NO ATTACHMENTS")

            found += 1

            if found >= 5:
                break

    except:
        pass

print("\nSearch Complete")