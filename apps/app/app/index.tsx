import { Link } from 'one'
import { Text, View } from 'react-native'

export default function Index() {
  return (
    <View
      style={{
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: '100%',
        backgroundColor: '#fff',
        paddingVertical: 40,
      }}
    >
      <Text>Hello world, from One</Text>
      <Link href="/test" asChild>
        <Text style={link}>Go to Test</Text>
      </Link>
      <Link href="/tabs" asChild>
        <Text style={link}>Tabs demo</Text>
      </Link>
      <Link href="/native" asChild>
        <Text style={link}>Native module demo</Text>
      </Link>
    </View>
  )
}

// keeps each link a comfortable tap target
const link = { paddingVertical: 12 }
