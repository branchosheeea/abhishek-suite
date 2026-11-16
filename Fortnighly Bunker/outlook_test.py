import win32com.client

outlook = win32com.client.Dispatch("Outlook.Application")
namespace = outlook.GetNamespace("MAPI")

inbox = namespace.GetDefaultFolder(6)

messages = inbox.Items

messages.Sort("[ReceivedTime]", True)

for i in range(1, 6):

    msg = messages.Item(i)

    print("--------------------------------")
    print("Subject :", msg.Subject)
    print("Received:", msg.ReceivedTime)